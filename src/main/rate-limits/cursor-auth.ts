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
import { parseCursorSessionToken, type CursorSessionToken } from './cursor-session-token'

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

  const keychainRead = await readKeychainToken()
  if (keychainRead.status === 'error') {
    errors.push(keychainRead.error)
  }
  if (keychainRead.status === 'ok') {
    const session = sessionFrom(
      keychainRead.token,
      'keychain',
      readCursorCliIdentity(cliConfigPath)
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
    const session = sessionFrom(cliRead.token, 'cli', readCursorCliIdentity(cliConfigPath))
    if (session) {
      return { status: 'ok', session }
    }
  }

  const desktopRead = readCursorDesktopProfile(desktopDbPath)
  if (desktopRead.status === 'error') {
    errors.push(desktopRead.error)
  }
  if (desktopRead.status === 'ok' && desktopRead.profile.accessToken) {
    const session = sessionFrom(
      desktopRead.profile.accessToken,
      'desktop',
      desktopIdentity(desktopRead.profile)
    )
    if (session) {
      return { status: 'ok', session }
    }
  }

  const firstError = errors[0]
  return firstError === undefined ? { status: 'missing' } : { status: 'error', error: firstError }
}
