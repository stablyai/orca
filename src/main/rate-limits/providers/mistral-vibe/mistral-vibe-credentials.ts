import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { secretServiceProcessEnvironment } from '../../../linux-secret-service/session-bus-environment'
import { loadWindowsSecurityAsync } from '../../../../shared/secure-storage/windows-security-addon'

// Vibe stores secrets with Python keyring: API keys under (service, env var name), its OIDC sign-in in its own slot.
const API_KEY_ENV = 'MISTRAL_API_KEY'
const API_KEY_SERVICES = ['ai.mistral.vibe', 'vibe'] as const
const OIDC_SERVICE = 'ai.mistral.vibe.oidc'
const OIDC_ENTRY = 'cli-oidc:v1:tokens'
const KEYRING_TIMEOUT_MS = 5_000
// Mistral keys are opaque alphanumerics; Windows reads cannot check the entry's user, so shape gates it.
const API_KEY_SHAPE = /^[A-Za-z0-9_-]{20,200}$/

export type MistralVibeOidcSession = {
  idToken: string
  idTokenExpiresAt: number | null
  organizationId: string
  workspaceId: string
}

export type MistralVibeCredential =
  | { kind: 'api-key'; apiKey: string; source: 'env' | 'dotenv' | 'keyring' }
  | { kind: 'oidc'; session: MistralVibeOidcSession }
  /** Signed in with OIDC but Vibe has not yet stored the workspace the token acts in. */
  | { kind: 'oidc-without-tenant' }
  /** macOS: the OIDC item exists, but its ACL trusts only Vibe's Python, so reading it would prompt. */
  | { kind: 'oidc-unreadable' }

export type MistralVibeCredentialRead =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credential: MistralVibeCredential }

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getMistralVibeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VIBE_HOME?.trim()
  return override ? override : join(homedir(), '.vibe')
}

/** The `MISTRAL_API_KEY` assignment of a dotenv file, following python-dotenv's quoting rules. */
export function parseMistralApiKeyFromDotenv(raw: string): string | null {
  let found: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?MISTRAL_API_KEY\s*=\s*(.*)$/.exec(line)
    if (!match) {
      continue
    }
    const raw = match[1].trim()
    const quote = raw[0]
    const quoted = (quote === '"' || quote === "'") && raw.lastIndexOf(quote) > 0
    const value = quoted ? raw.slice(1, raw.lastIndexOf(quote)) : raw.replace(/\s+#.*$/, '')
    // python-dotenv keeps the last assignment; Vibe ignores an empty one.
    found = value.trim() || null
  }
  return found
}

function decodeWindowsKeyringBlob(bytes: Uint8Array): string | null {
  // Python keyring's Windows backend writes the secret as UTF-16LE.
  if (bytes.byteLength % 2 !== 0) {
    return null
  }
  try {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function readWindowsKeyring(service: string, username: string): Promise<string | null> {
  const loaded = await loadWindowsSecurityAsync()
  if ('error' in loaded) {
    throw new Error('The Windows credential store is unavailable')
  }
  // Python keyring uses the bare service as target, or `user@service` once a second user shares it.
  for (const target of [`${username}@${service}`, service]) {
    let bytes: Uint8Array | null
    try {
      bytes = loaded.addon.readGenericCredential(target)
    } catch (error) {
      // ERROR_NOT_FOUND
      if (error instanceof Error && 'win32Code' in error && error.win32Code === 1168) {
        continue
      }
      throw new Error('The Windows credential store could not be read')
    }
    if (bytes !== null) {
      const decoded = decodeWindowsKeyringBlob(bytes)
      if (decoded !== null) {
        return decoded
      }
    }
  }
  return null
}

async function readMacOSKeychain(service: string, account: string): Promise<string | null> {
  const result = await runProcess({
    program: '/usr/bin/security',
    args: ['find-generic-password', '-s', service, '-a', account, '-w'],
    timeoutMs: KEYRING_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  }).catch(() => {
    // Child-process errors may embed credential-bearing output.
    throw new Error('The macOS Keychain could not be read')
  })
  if (result.timedOut || result.signal || result.outputTruncated) {
    throw new Error('The macOS Keychain could not be read')
  }
  if (result.code === 44) {
    return null
  }
  if (result.code !== 0) {
    throw new Error('The macOS Keychain could not be read')
  }
  return result.stdout.replace(/\r?\n$/, '')
}

/** Whether a Keychain item exists, from its attributes only, so macOS shows no access prompt. */
async function hasMacOSKeychainItem(service: string, account: string): Promise<boolean> {
  const result = await runProcess({
    program: '/usr/bin/security',
    args: ['find-generic-password', '-s', service, '-a', account],
    timeoutMs: KEYRING_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  }).catch(() => {
    throw new Error('The macOS Keychain could not be read')
  })
  if (!result.timedOut && !result.signal && (result.code === 0 || result.code === 44)) {
    return result.code === 0
  }
  throw new Error('The macOS Keychain could not be read')
}

async function readLinuxKeyring(service: string, username: string): Promise<string | null> {
  // `search` without --unlock never prompts a locked keyring on a background poll.
  const result = await runProcess({
    program: 'secret-tool',
    args: ['search', 'service', service, 'username', username],
    env: await secretServiceProcessEnvironment(),
    timeoutMs: KEYRING_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw new Error('The Linux keyring could not be read')
  })
  if (result === null) {
    return null
  }
  if (result.timedOut || result.signal || result.outputTruncated) {
    throw new Error('The Linux keyring could not be read')
  }
  if (result.code !== 0) {
    // secret-tool exits 1 when nothing matches.
    if (result.code === 1 && !result.stdout.trim()) {
      return null
    }
    throw new Error('The Linux keyring could not be read')
  }
  return /^secret = (.*)$/m.exec(result.stdout)?.[1] ?? null
}

function readKeyring(service: string, username: string): Promise<string | null> {
  if (process.platform === 'win32') {
    return readWindowsKeyring(service, username)
  }
  if (process.platform === 'darwin') {
    return readMacOSKeychain(service, username)
  }
  if (process.platform === 'linux') {
    return readLinuxKeyring(service, username)
  }
  return Promise.resolve(null)
}

function withTimeout<T>(pending: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), KEYRING_TIMEOUT_MS).unref?.()
    })
  ])
}

async function readDotenvApiKey(home: string): Promise<string | null> {
  try {
    return parseMistralApiKeyFromDotenv(await readFile(join(home, '.env'), 'utf-8'))
  } catch {
    return null
  }
}

async function readKeyringApiKey(): Promise<string | null> {
  for (const service of API_KEY_SERVICES) {
    const value = (await readKeyring(service, API_KEY_ENV))?.trim()
    if (value && API_KEY_SHAPE.test(value)) {
      return value
    }
  }
  return null
}

/** Parse Vibe's stored OIDC token slot without exposing anything beyond what a usage read needs. */
export function parseMistralVibeOidcTokens(raw: string): MistralVibeCredential | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isJsonRecord(value)) {
    return null
  }
  const idToken = value.id_token
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return null
  }
  const tenant = value.tenant
  if (
    !isJsonRecord(tenant) ||
    typeof tenant.organization_id !== 'string' ||
    typeof tenant.workspace_id !== 'string'
  ) {
    return { kind: 'oidc-without-tenant' }
  }
  const expiresAt = value.id_token_expires_at
  return {
    kind: 'oidc',
    session: {
      idToken,
      idTokenExpiresAt:
        typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null,
      organizationId: tenant.organization_id,
      workspaceId: tenant.workspace_id
    }
  }
}

async function readKeyringOidc(): Promise<MistralVibeCredential | null> {
  // macOS: the item's ACL trusts only Vibe's Python, so reading it would prompt on every poll.
  if (process.platform === 'darwin') {
    return (await hasMacOSKeychainItem(OIDC_SERVICE, OIDC_ENTRY))
      ? { kind: 'oidc-unreadable' }
      : null
  }
  const raw = await readKeyring(OIDC_SERVICE, OIDC_ENTRY)
  return raw ? parseMistralVibeOidcTokens(raw) : null
}

/** Mirror Vibe's precedence: process env, then VIBE_HOME/.env, then the keyring; OIDC sign-in last. */
export async function readMistralVibeCredential(
  env: NodeJS.ProcessEnv = process.env
): Promise<MistralVibeCredentialRead> {
  const envKey = env[API_KEY_ENV]?.trim()
  if (envKey) {
    return { status: 'ok', credential: { kind: 'api-key', apiKey: envKey, source: 'env' } }
  }
  const dotenvKey = await readDotenvApiKey(getMistralVibeHome(env))
  if (dotenvKey) {
    return { status: 'ok', credential: { kind: 'api-key', apiKey: dotenvKey, source: 'dotenv' } }
  }
  let keyringError: string | null = null
  try {
    const keyringKey = await withTimeout(readKeyringApiKey(), 'The keyring did not respond')
    if (keyringKey) {
      return {
        status: 'ok',
        credential: { kind: 'api-key', apiKey: keyringKey, source: 'keyring' }
      }
    }
    const oidc = await withTimeout(readKeyringOidc(), 'The keyring did not respond')
    if (oidc) {
      return { status: 'ok', credential: oidc }
    }
  } catch (error) {
    keyringError = error instanceof Error ? error.message : 'The keyring could not be read'
  }
  return keyringError ? { status: 'error', error: keyringError } : { status: 'missing' }
}
