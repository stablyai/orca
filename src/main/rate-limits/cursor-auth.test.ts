import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keychainState = vi.hoisted<{ token: string | null; error: Error | null }>(() => ({
  token: null,
  error: null
}))
const files = vi.hoisted<() => Map<string, string | Error>>(() => {
  const map = new Map<string, string | Error>()
  return () => map
})
const desktopState = vi.hoisted<{
  result: { status: string; profile?: unknown; error?: string }
}>(() => ({ result: { status: 'missing' } }))

vi.mock('../macos-keychain/generic-password', () => ({
  readKeychainPassword: async () => {
    if (keychainState.error) {
      throw keychainState.error
    }
    return keychainState.token
  }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => files().has(path),
  readFileSync: (path: string) => {
    const entry = files().get(path)
    if (entry instanceof Error) {
      throw entry
    }
    if (entry === undefined) {
      throw new Error('ENOENT')
    }
    return entry
  }
}))

vi.mock('./cursor-desktop-state-db', () => ({
  readCursorDesktopProfile: () => desktopState.result
}))

import { readCursorAuthSession, readCursorCliIdentity } from './cursor-auth'

type JwtSegment = Record<string, unknown>

function jwt(sub: string): string {
  const encode = (value: JwtSegment): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ sub, exp: 2_000_000_000 })}.signature`
}

const CLI_AUTH = '/cli/auth.json'
const CLI_CONFIG = '/cli/cli-config.json'
const DESKTOP_DB = '/desktop/state.vscdb'
const options = {
  cliAuthPath: CLI_AUTH,
  cliConfigPath: CLI_CONFIG,
  desktopStateDbPath: DESKTOP_DB
}

beforeEach(() => {
  keychainState.token = null
  keychainState.error = null
  files().clear()
  desktopState.result = { status: 'missing' }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readCursorAuthSession', () => {
  it('prefers the keychain session cursor-agent 2026.06+ writes', async () => {
    keychainState.token = jwt('auth0|user_keychain')
    files().set(CLI_AUTH, JSON.stringify({ accessToken: jwt('auth0|user_file') }))
    const result = await readCursorAuthSession(options)
    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.session.source).toBe('keychain')
    expect(result.status === 'ok' && result.session.token.subject).toBe('auth0|user_keychain')
  })

  it('names the signed-in account from cli-config.json, which holds no token', async () => {
    keychainState.token = jwt('auth0|user_1')
    files().set(
      CLI_CONFIG,
      JSON.stringify({ authInfo: { email: 'dev@example.com', displayName: 'Dev' } })
    )
    const result = await readCursorAuthSession(options)
    expect(result.status === 'ok' && result.session.email).toBe('dev@example.com')
    expect(result.status === 'ok' && result.session.displayName).toBe('Dev')
  })

  it('falls back to the legacy CLI auth file when the keychain holds nothing', async () => {
    files().set(CLI_AUTH, JSON.stringify({ accessToken: jwt('auth0|user_file') }))
    const result = await readCursorAuthSession(options)
    expect(result.status === 'ok' && result.session.source).toBe('cli')
  })

  it('falls back to Cursor IDE when no CLI session exists', async () => {
    desktopState.result = {
      status: 'ok',
      profile: {
        accessToken: jwt('auth0|user_ide'),
        email: 'ide@example.com',
        membershipType: 'pro',
        subscriptionStatus: 'active'
      }
    }
    const result = await readCursorAuthSession(options)
    expect(result.status === 'ok' && result.session.source).toBe('desktop')
    expect(result.status === 'ok' && result.session.membershipType).toBe('pro')
  })

  it('does not let a locked keychain hide a readable CLI session', async () => {
    keychainState.error = new Error('User interaction is not allowed')
    files().set(CLI_AUTH, JSON.stringify({ accessToken: jwt('auth0|user_file') }))
    const result = await readCursorAuthSession(options)
    expect(result.status === 'ok' && result.session.source).toBe('cli')
  })

  it('reports the first read failure when no source yields a session', async () => {
    keychainState.error = new Error('User interaction is not allowed')
    const result = await readCursorAuthSession(options)
    expect(result).toEqual({
      status: 'error',
      error: 'Unable to read the Cursor login from the macOS Keychain'
    })
  })

  it('reports signed out when nothing is stored anywhere', async () => {
    expect(await readCursorAuthSession(options)).toEqual({ status: 'missing' })
  })

  it('treats a signed-out CLI auth file as missing, not as an error', async () => {
    files().set(CLI_AUTH, JSON.stringify({}))
    expect(await readCursorAuthSession(options)).toEqual({ status: 'missing' })
  })

  it('keeps the local auth path out of the surfaced error', async () => {
    files().set(
      CLI_AUTH,
      new Error('EACCES: permission denied, open /Users/someone/.cursor/auth.json')
    )
    const result = await readCursorAuthSession(options)
    expect(result).toEqual({ status: 'error', error: 'Unable to read the Cursor CLI auth file' })
  })

  it('reports invalid JSON distinctly from an unreadable file', async () => {
    files().set(CLI_AUTH, '{ not json')
    const result = await readCursorAuthSession(options)
    expect(result).toEqual({ status: 'error', error: 'Cursor CLI auth file is invalid' })
  })

  it('skips a stored token that carries no subject', async () => {
    keychainState.token = 'not-a-jwt'
    expect(await readCursorAuthSession(options)).toEqual({ status: 'missing' })
  })
})

describe('readCursorCliIdentity', () => {
  it('returns empty identity for a config with no authInfo', () => {
    files().set(CLI_CONFIG, JSON.stringify({ version: 1 }))
    expect(readCursorCliIdentity(CLI_CONFIG)).toEqual({
      email: null,
      displayName: null,
      membershipType: null,
      subscriptionStatus: null
    })
  })

  it('survives a corrupt config file', () => {
    files().set(CLI_CONFIG, '{{{')
    expect(readCursorCliIdentity(CLI_CONFIG).email).toBeNull()
  })
})
