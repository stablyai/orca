import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ManagedCliHomeProvider } from '../../shared/managed-account-types'

const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024
const MAX_TOKEN_LENGTH = 32_768

type CredentialScope = {
  sourceEnvHome: string
  files: { relativePath: string; required: boolean }[]
}

function assertNonSymlinkDirectory(path: string, required: boolean): boolean {
  if (!existsSync(path)) {
    if (required) {
      throw new Error('The selected provider home does not contain required credentials.')
    }
    return false
  }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      'Managed provider credential directories must be regular directories, not symbolic links.'
    )
  }
  return true
}

function assertRegularBoundedFile(path: string, required: boolean): boolean {
  if (!existsSync(path)) {
    if (required) {
      throw new Error('The selected provider home does not contain required credentials.')
    }
    return false
  }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Managed provider credentials must be regular files, not symbolic links.')
  }
  if (info.size <= 0 || info.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error('A managed provider credential file exceeds the 1 MB safety limit.')
  }
  return true
}

function parseJsonObject(path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    throw new Error('A managed provider credential file is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('A managed provider credential file must contain an object.')
  }
  return parsed as Record<string, unknown>
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    !value.includes('\u0000') &&
    !/[\r\n]/.test(value)
  )
}

function validateGrokAuth(path: string): void {
  const auth = parseJsonObject(path)
  const hasToken = Object.values(auth).some(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      isBoundedToken((entry as { key?: unknown }).key)
  )
  if (!hasToken) {
    throw new Error('The selected Grok home does not contain a valid signed-in session.')
  }
}

function validateGeminiAuth(path: string): void {
  const auth = parseJsonObject(path)
  if (!isBoundedToken(auth.refresh_token) && !isBoundedToken(auth.access_token)) {
    throw new Error('The selected Gemini home does not contain valid OAuth credentials.')
  }
}

function resolveCredentialScope(
  provider: ManagedCliHomeProvider,
  sourceHome: string
): CredentialScope {
  const selected = resolve(sourceHome)
  if (!existsSync(selected)) {
    throw new Error('The selected provider home does not exist.')
  }
  const info = lstatSync(selected)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The selected provider home must be a directory, not a symbolic link.')
  }
  if (provider === 'grok') {
    const sourceEnvHome = existsSync(join(selected, 'auth.json'))
      ? selected
      : join(selected, '.grok')
    if (sourceEnvHome !== selected) {
      assertNonSymlinkDirectory(sourceEnvHome, true)
    }
    return {
      sourceEnvHome,
      files: [{ relativePath: 'auth.json', required: true }]
    }
  }
  const sourceEnvHome =
    basename(selected) === '.gemini' && existsSync(join(selected, 'oauth_creds.json'))
      ? dirname(selected)
      : selected
  if (sourceEnvHome !== selected) {
    assertNonSymlinkDirectory(sourceEnvHome, true)
  }
  assertNonSymlinkDirectory(join(sourceEnvHome, '.gemini'), true)
  return {
    sourceEnvHome,
    files: [
      { relativePath: join('.gemini', 'oauth_creds.json'), required: true },
      { relativePath: join('.gemini', 'google_accounts.json'), required: false },
      { relativePath: join('.gemini', 'user_id'), required: false }
    ]
  }
}

function copyGeminiAuthSelection(sourceEnvHome: string, destinationHome: string): void {
  const source = join(sourceEnvHome, '.gemini', 'settings.json')
  if (!assertRegularBoundedFile(source, false)) {
    return
  }
  const settings = parseJsonObject(source)
  const security = settings.security
  const auth =
    security && typeof security === 'object' && !Array.isArray(security)
      ? (security as { auth?: unknown }).auth
      : undefined
  const selectedType =
    auth && typeof auth === 'object' && !Array.isArray(auth)
      ? (auth as { selectedType?: unknown }).selectedType
      : undefined
  if (!isBoundedToken(selectedType) || selectedType.length > 120) {
    return
  }
  const destination = join(destinationHome, '.gemini', 'settings.json')
  writeFileSync(
    destination,
    `${JSON.stringify({ security: { auth: { selectedType } } }, null, 2)}\n`,
    { mode: 0o600 }
  )
}

export function copyManagedProviderCredentialScope(args: {
  provider: ManagedCliHomeProvider
  sourceHome: string
  destinationHome: string
}): void {
  const scope = resolveCredentialScope(args.provider, args.sourceHome)
  const sourceAuth =
    args.provider === 'grok'
      ? join(scope.sourceEnvHome, 'auth.json')
      : join(scope.sourceEnvHome, '.gemini', 'oauth_creds.json')
  assertRegularBoundedFile(sourceAuth, true)
  if (args.provider === 'grok') {
    validateGrokAuth(sourceAuth)
  } else {
    validateGeminiAuth(sourceAuth)
  }
  mkdirSync(args.destinationHome, { recursive: true, mode: 0o700 })
  for (const file of scope.files) {
    const source = join(scope.sourceEnvHome, file.relativePath)
    if (!assertRegularBoundedFile(source, file.required)) {
      continue
    }
    const destination = join(args.destinationHome, file.relativePath)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(source, destination)
    if (process.platform !== 'win32') {
      chmodSync(destination, 0o600)
    }
  }
  if (args.provider === 'gemini') {
    copyGeminiAuthSelection(scope.sourceEnvHome, args.destinationHome)
  }
  if (process.platform !== 'win32') {
    chmodSync(args.destinationHome, 0o700)
    if (args.provider === 'gemini') {
      chmodSync(join(args.destinationHome, '.gemini'), 0o700)
    }
  }
}
