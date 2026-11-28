import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { readKeychainPassword } from '../../../macos-keychain/generic-password'
import { createLatestBlobDpapiUnprotect } from '../../../windows-dpapi/current-user-unprotect'
import { readCursorLinuxKeyringSecret, type CursorLinuxKeyringRead } from './cursor-linux-keyring'
import { decodeCursorIdeToken } from './cursor-windows-safe-storage'
import {
  getCursorCliAuthPath,
  getCursorCliConfigPath,
  getCursorDesktopStateDbPath,
  type CursorAuthSource
} from './cursor-auth-paths'
import type { CursorDesktopProfile } from '../../../foreign-sqlite-readers/cursor-profile-result'
import { readCursorDesktopProfile } from '../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import {
  isCursorSessionTokenExpired,
  parseCursorSessionToken,
  type CursorSessionToken
} from './cursor-session-token'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'

// cursor-agent 2026.06+ stores tokens in Keychain instead of auth.json.
const KEYCHAIN_SERVICE = 'cursor-access-token'
const KEYCHAIN_ACCOUNT = 'cursor-user'

export type CursorIdentity = {
  email: string | null
  displayName: string | null
  membershipType: string | null
  subscriptionStatus: string | null
}

export type CursorAuthSession = CursorIdentity & {
  token: CursorSessionToken
  source: CursorAuthSource
}

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: CursorAuthSession }

function emptyIdentity(): CursorIdentity {
  return { email: null, displayName: null, membershipType: null, subscriptionStatus: null }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const cliConfigSchema = lazyZodSchema(() =>
  z.object({
    authInfo: z.object({ email: z.unknown(), displayName: z.unknown() }).partial().optional()
  })
)

// Linux/Windows cursor-agent keep this shape in the OS secret store; auth.json keeps only `storedIn`.
const cliAuthFileSchema = lazyZodSchema(() =>
  z.object({ accessToken: z.unknown(), storedIn: z.unknown() }).partial()
)

// Windows cursor-agent's secret store: `auth.dpapi` next to auth.json, holding a current-user DPAPI blob.
const dpapiFileSchema = lazyZodSchema(() =>
  z.object({
    version: z.literal(1),
    dpapi: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)
  })
)
const DPAPI_ERROR = 'Unable to decrypt the Cursor CLI login'

/** `cli-config.json` carries the signed-in identity for keychain-backed CLI sessions. */
export function readCursorCliIdentity(configPath = getCursorCliConfigPath()): CursorIdentity {
  if (!existsSync(configPath)) {
    return emptyIdentity()
  }
  try {
    const parsed = cliConfigSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')))
    if (!parsed.success) {
      return emptyIdentity()
    }
    return {
      ...emptyIdentity(),
      email: nonEmpty(parsed.data.authInfo?.email),
      displayName: nonEmpty(parsed.data.authInfo?.displayName)
    }
  } catch {
    return emptyIdentity()
  }
}

type TokenReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; token: string }

type CliFileReadResult = TokenReadResult | { status: 'in-keyring' }

function parseCliCredentials(text: string): CliFileReadResult {
  const parsed = cliAuthFileSchema.safeParse(JSON.parse(text))
  const token = parsed.success ? parsed.data.accessToken : null
  if (typeof token === 'string' && token.length > 0) {
    return { status: 'ok', token }
  }
  return parsed.success && parsed.data.storedIn === 'os-secret-store'
    ? { status: 'in-keyring' }
    : { status: 'missing' }
}

// Providers may prompt on each search (KeePassXC unlock-before-search), so every outcome, failures included,
// is reused until cursor-agent rewrites auth.json; concurrent reads for the same mtime share one secret-tool run.
// Explicit user refreshes may retry a settled non-ok outcome so unlocking the keyring recovers without rewriting auth.json.
let linuxKeyringRead: {
  authPath: string
  authMtimeMs: number
  result: Promise<TokenReadResult>
  settledStatus?: TokenReadResult['status']
} | null = null

function tokenFromSecret(secret: string): TokenReadResult {
  try {
    const parsed = parseCliCredentials(secret)
    return parsed.status === 'ok' ? parsed : { status: 'missing' }
  } catch {
    return { status: 'missing' }
  }
}

function tokenFromKeyringRead(read: CursorLinuxKeyringRead): TokenReadResult {
  return read.status === 'ok' ? tokenFromSecret(read.secret) : read
}

async function readLinuxKeyringToken(
  authPath: string,
  cliFile: CliFileReadResult,
  retryFailure: boolean
): Promise<TokenReadResult> {
  // Only cursor-agent's auth.json marker justifies reading the keyring.
  if (cliFile.status !== 'in-keyring') {
    return { status: 'missing' }
  }
  let authMtimeMs: number
  try {
    // cursor-agent rewrites auth.json after every keyring write, so its mtime versions the secret.
    authMtimeMs = (await stat(authPath)).mtimeMs
  } catch {
    return { status: 'missing' }
  }
  const shouldRetrySettledFailure =
    retryFailure &&
    linuxKeyringRead?.settledStatus !== undefined &&
    linuxKeyringRead.settledStatus !== 'ok'
  if (
    linuxKeyringRead?.authPath !== authPath ||
    linuxKeyringRead.authMtimeMs !== authMtimeMs ||
    shouldRetrySettledFailure
  ) {
    const entry: NonNullable<typeof linuxKeyringRead> = {
      authPath,
      authMtimeMs,
      result: readCursorLinuxKeyringSecret()
        .then(tokenFromKeyringRead)
        .then((outcome) => {
          entry.settledStatus = outcome.status
          return outcome
        })
    }
    linuxKeyringRead = entry
  }
  return linuxKeyringRead.result
}

// cursor-agent re-encrypts on every write, so the blob versions the token: one PowerShell run per login change.
const unprotectCliAuthBlob = createLatestBlobDpapiUnprotect()

async function readWindowsDpapiToken(
  authPath: string,
  cliFile: CliFileReadResult
): Promise<CliFileReadResult> {
  if (cliFile.status !== 'in-keyring') {
    return cliFile
  }
  let blob: string
  try {
    const parsed = dpapiFileSchema.safeParse(
      JSON.parse(await readFile(join(dirname(authPath), 'auth.dpapi'), 'utf8'))
    )
    if (!parsed.success) {
      return { status: 'missing' }
    }
    blob = parsed.data.dpapi
  } catch {
    return { status: 'missing' }
  }
  let plaintext: Buffer | null
  try {
    plaintext = await unprotectCliAuthBlob(blob)
  } catch {
    return { status: 'error', error: DPAPI_ERROR }
  }
  return plaintext
    ? tokenFromSecret(plaintext.toString('utf8'))
    : { status: 'error', error: DPAPI_ERROR }
}

async function readKeychainToken(): Promise<TokenReadResult> {
  if (process.platform !== 'darwin') {
    return { status: 'missing' }
  }
  try {
    const token = await readKeychainPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    return token ? { status: 'ok', token } : { status: 'missing' }
  } catch {
    // Locked/denied Keychain must not mask readable auth.json.
    return { status: 'error', error: 'Unable to read the Cursor login from the macOS Keychain' }
  }
}

function readCliFileToken(authPath: string): CliFileReadResult {
  if (!existsSync(authPath)) {
    return { status: 'missing' }
  }
  try {
    return parseCliCredentials(readFileSync(authPath, 'utf8'))
  } catch (error) {
    // Filesystem errors include paths; keep usernames out of account state.
    return {
      status: 'error',
      error:
        error instanceof SyntaxError
          ? 'Cursor CLI auth file is invalid'
          : 'Unable to read the Cursor CLI auth file'
    }
  }
}

function sessionFrom(
  raw: string,
  source: CursorAuthSource,
  identity: CursorIdentity
): CursorAuthSession | null {
  const token = parseCursorSessionToken(raw)
  return token ? { ...identity, token, source } : null
}

function desktopIdentity(profile: CursorDesktopProfile): CursorIdentity {
  return {
    email: profile.email,
    displayName: null,
    membershipType: profile.membershipType,
    subscriptionStatus: profile.subscriptionStatus
  }
}

export type CursorAuthReadOptions = {
  cliAuthPath?: string
  cliConfigPath?: string
  desktopStateDbPath?: string
  /** Bypass a settled non-ok Linux keyring cache entry (e.g. on an explicit user refresh after unlocking). */
  retryLinuxKeyringError?: boolean
}

/** Prefer live CLI sessions (OS secret store, then legacy auth.json), then IDE sessions; never refresh or write credentials. */
export async function readCursorAuthSession(
  options: CursorAuthReadOptions = {}
): Promise<CursorAuthReadResult> {
  const cliAuthPath = options.cliAuthPath ?? getCursorCliAuthPath()
  const cliConfigPath = options.cliConfigPath ?? getCursorCliConfigPath()
  const desktopDbPath = options.desktopStateDbPath ?? getCursorDesktopStateDbPath()
  const errors: string[] = []
  // A live lower-priority session outranks an expired CLI token.
  let expired: CursorAuthSession | null = null
  const takeLive = (session: CursorAuthSession | null): CursorAuthSession | null => {
    if (!session) {
      return null
    }
    if (isCursorSessionTokenExpired(session.token)) {
      expired ??= session
      return null
    }
    return session
  }

  let cliFile: CliFileReadResult | undefined
  const readCliFile = (): CliFileReadResult => (cliFile ??= readCliFileToken(cliAuthPath))
  const keychainRead =
    process.platform === 'linux'
      ? await readLinuxKeyringToken(
          cliAuthPath,
          readCliFile(),
          options.retryLinuxKeyringError === true
        )
      : await readKeychainToken()
  if (keychainRead.status === 'error') {
    errors.push(keychainRead.error)
  }
  if (keychainRead.status === 'ok') {
    const session = takeLive(
      sessionFrom(keychainRead.token, 'keychain', readCursorCliIdentity(cliConfigPath))
    )
    if (session) {
      return { status: 'ok', session }
    }
  }

  const cliRead =
    process.platform === 'win32'
      ? await readWindowsDpapiToken(cliAuthPath, readCliFile())
      : readCliFile()
  if (cliRead.status === 'error') {
    errors.push(cliRead.error)
  }
  if (cliRead.status === 'ok') {
    const session = takeLive(
      sessionFrom(cliRead.token, 'cli', readCursorCliIdentity(cliConfigPath))
    )
    if (session) {
      return { status: 'ok', session }
    }
  }

  // Busy IDE databases are transient; reporting their lock would leave unrelated IDE users with a permanent alert.
  const desktopRead = await readCursorDesktopProfile(desktopDbPath)
  if (desktopRead.status === 'ok' && desktopRead.profile.accessToken) {
    const stored = desktopRead.profile.accessToken
    // A failed key read may hide a live IDE sign-in, so it outranks expired-login guidance.
    const ideToken = await decodeCursorIdeToken(stored, desktopDbPath)
    if (ideToken.status === 'error') {
      return { status: 'error', error: ideToken.error }
    }
    const session =
      ideToken.status === 'ok'
        ? takeLive(sessionFrom(ideToken.token, 'desktop', desktopIdentity(desktopRead.profile)))
        : null
    if (session) {
      return { status: 'ok', session }
    }
  }

  // With no live token, return the expired session so the fetcher can offer login guidance.
  if (expired) {
    return { status: 'ok', session: expired }
  }

  const firstError = errors[0]
  return firstError === undefined ? { status: 'missing' } : { status: 'error', error: firstError }
}
