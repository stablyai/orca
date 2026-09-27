import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { readKeychainPassword } from '../macos-keychain/generic-password'
import {
  getCursorCliAuthPath,
  getCursorCliConfigPath,
  getCursorDesktopStateDbPath,
  type CursorAuthSource
} from './cursor-auth-paths'
import { readCursorDesktopProfile, type CursorDesktopProfile } from './cursor-desktop-state-db'
import {
  isCursorSessionTokenExpired,
  parseCursorSessionToken,
  type CursorSessionToken
} from './cursor-session-token'

// Why: cursor-agent 2026.06+ stores the session in the login keychain, not auth.json.
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

const cliConfigSchema = z.object({
  authInfo: z.object({ email: z.unknown(), displayName: z.unknown() }).partial().optional()
})

const cliAuthFileSchema = z.object({ accessToken: z.unknown() }).partial()

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

async function readKeychainToken(): Promise<TokenReadResult> {
  if (process.platform !== 'darwin') {
    return { status: 'missing' }
  }
  try {
    const token = await readKeychainPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    return token ? { status: 'ok', token } : { status: 'missing' }
  } catch {
    // Why: a denied or locked keychain must not mask a readable auth.json below it.
    return { status: 'error', error: 'Unable to read the Cursor login from the macOS Keychain' }
  }
}

function readCliFileToken(authPath: string): TokenReadResult {
  if (!existsSync(authPath)) {
    return { status: 'missing' }
  }
  try {
    const parsed = cliAuthFileSchema.safeParse(JSON.parse(readFileSync(authPath, 'utf8')))
    const token = parsed.success ? parsed.data.accessToken : null
    return typeof token === 'string' && token.length > 0
      ? { status: 'ok', token }
      : { status: 'missing' }
  } catch (error) {
    // Why: filesystem errors quote the full path; account state must not leak local usernames.
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
}

/**
 * Resolve the Cursor session Orca should poll with, preferring the CLI login
 * (keychain, then legacy auth.json) over the Cursor IDE's own session. Read-only:
 * Orca never writes, refreshes, or rotates the user's Cursor credentials.
 */
export async function readCursorAuthSession(
  options: CursorAuthReadOptions = {}
): Promise<CursorAuthReadResult> {
  const cliAuthPath = options.cliAuthPath ?? getCursorCliAuthPath()
  const cliConfigPath = options.cliConfigPath ?? getCursorCliConfigPath()
  const desktopDbPath = options.desktopStateDbPath ?? getCursorDesktopStateDbPath()
  const errors: string[] = []
  // Why a live session wins over precedence: a user who signed the CLI in once and
  // now works only in the IDE has an expired keychain token in front of a fresh
  // desktop one. Returning the first token that parses would report "sign-in
  // expired" forever while a usable session sat one source below.
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

  const keychainRead = await readKeychainToken()
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

  const cliRead = readCliFileToken(cliAuthPath)
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

  // Why not pushed to `errors`: the IDE holds a lock on state.vscdb while it runs,
  // so a busy open is transient. Reporting it would pin an alert-triangle bar on
  // every Cursor IDE user who never set Cursor up in Orca.
  const desktopRead = readCursorDesktopProfile(desktopDbPath)
  if (desktopRead.status === 'ok' && desktopRead.profile.accessToken) {
    const session = takeLive(
      sessionFrom(desktopRead.profile.accessToken, 'desktop', desktopIdentity(desktopRead.profile))
    )
    if (session) {
      return { status: 'ok', session }
    }
  }

  // Why still returned: with no live session anywhere, the expired one is what the
  // user must act on, and the fetcher turns it into "run cursor-agent login".
  if (expired) {
    return { status: 'ok', session: expired }
  }

  const firstError = errors[0]
  return firstError === undefined ? { status: 'missing' } : { status: 'error', error: firstError }
}
