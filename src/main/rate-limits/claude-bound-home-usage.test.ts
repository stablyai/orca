import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict
} from '../claude-accounts/keychain'
import { fetchBoundClaudeHomeUsage } from './claude-bound-home-usage'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { okProvider } from './rate-limit-service-test-harness'

/**
 * The D9 ratchet. Orca is read-only toward a bound directory, so this file's job is to make a
 * *write* — a file write, a credential stage, a Keychain item write, a PTY spawn, a token refresh —
 * fail the suite, while leaving every *read* the production path legitimately needs working.
 *
 * Reads stay real (and are recorded, so the "nothing outside the bound directory" claim is
 * asserted, not just titled). Never move a verb from a read list to an allowed-write list.
 */
const ratchet = vi.hoisted(() => {
  const readOnlyFsVerbs = new Set([
    'readFile',
    'readFileSync',
    'readdir',
    'readdirSync',
    'stat',
    'statSync',
    'lstat',
    'lstatSync',
    'access',
    'accessSync',
    'realpath',
    'realpathSync',
    'opendir',
    'opendirSync',
    'readlink',
    'readlinkSync',
    'existsSync'
  ])
  // Only argv shapes that cannot mutate anything. `security add-generic-password` is the D10 write.
  const readOnlyCommands = new Map([['security', new Set(['find-generic-password'])]])
  const readPaths: string[] = []

  const isPlainObject = (value: unknown): value is object =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

  const guardModule = (
    actual: object,
    label: string,
    allowed: ReadonlySet<string> = new Set<string>(),
    depth = 1
  ): Record<string, unknown> => {
    const guarded: Record<string, unknown> = {}
    for (const name of Object.keys(actual)) {
      const value: unknown = Reflect.get(actual, name)
      if (typeof value === 'function' && allowed.has(name)) {
        guarded[name] = (...args: unknown[]) => {
          if (typeof args[0] === 'string') {
            readPaths.push(args[0])
          }
          return Reflect.apply(value, undefined, args)
        }
        continue
      }
      if (typeof value === 'function') {
        guarded[name] = () => {
          throw new Error(`D9 violation: bound-home usage called ${label}.${name}`)
        }
        continue
      }
      // Why: `node:fs` exports `promises` as an object, so an unrecursed copy would leave
      // `fs.promises.writeFile` and every sibling write verb live and unguarded.
      guarded[name] =
        depth > 0 && isPlainObject(value)
          ? guardModule(value, `${label}.${name}`, allowed, depth - 1)
          : value
    }
    return guarded
  }

  const describeSpawn = (args: unknown[]): { command: string; verb: string } => {
    // Covers both `execFile(command, args)` and `runProcess({ command, args })`.
    const spec = isPlainObject(args[0]) ? args[0] : { command: args[0], args: args[1] }
    const argv: unknown = Reflect.get(spec, 'args')
    return {
      command: String(Reflect.get(spec, 'command')),
      verb: Array.isArray(argv) && argv.length > 0 ? String(argv[0]) : ''
    }
  }

  /** A spawn is the sink for a Keychain write and for a PTY, so guard the argv, not the import. */
  const guardSpawnModule = (actual: object, label: string): Record<string, unknown> => {
    const guarded: Record<string, unknown> = {}
    for (const name of Object.keys(actual)) {
      const value: unknown = Reflect.get(actual, name)
      if (typeof value !== 'function') {
        guarded[name] = value
        continue
      }
      guarded[name] = (...args: unknown[]) => {
        const { command, verb } = describeSpawn(args)
        if (readOnlyCommands.get(command)?.has(verb)) {
          return Reflect.apply(value, undefined, args)
        }
        throw new Error(`D9 violation: bound-home usage ran ${label}.${name} ${command} ${verb}`)
      }
    }
    return guarded
  }

  return { readOnlyFsVerbs, guardModule, guardSpawnModule, readPaths }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<object>()
  const guarded = ratchet.guardModule(actual, 'node:fs/promises', ratchet.readOnlyFsVerbs)
  return { ...guarded, default: guarded }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<object>()
  const guarded = ratchet.guardModule(actual, 'node:fs', ratchet.readOnlyFsVerbs)
  return { ...guarded, default: guarded }
})

vi.mock('node:child_process', async (importOriginal) => {
  const guarded = ratchet.guardSpawnModule(await importOriginal<object>(), 'node:child_process')
  return { ...guarded, default: guarded }
})

vi.mock('../../shared/child-process/run-process', async (importOriginal) =>
  ratchet.guardSpawnModule(await importOriginal<object>(), 'shared/child-process')
)

// Why the read exports survive: deciding whether a bound directory is signed in *requires* reading
// its scoped Keychain item on macOS. They are stubbed so the suite never depends on — or reads —
// the developer's real Keychain; every write export still throws.
vi.mock('../claude-accounts/keychain', async (importOriginal) => ({
  ...ratchet.guardModule(await importOriginal<object>(), 'keychain'),
  readActiveClaudeKeychainCredentials: vi.fn(async () => null),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(async () => null)
}))

vi.mock('../claude-accounts/oauth-refresh', async (importOriginal) =>
  ratchet.guardModule(await importOriginal<object>(), 'oauth-refresh')
)

vi.mock('./claude-managed-account-credentials', async (importOriginal) =>
  ratchet.guardModule(await importOriginal<object>(), 'claude-managed-account-credentials')
)

vi.mock('./claude-managed-usage-panel', async (importOriginal) =>
  ratchet.guardModule(await importOriginal<object>(), 'claude-managed-usage-panel')
)

vi.mock('./claude-pty', async (importOriginal) =>
  ratchet.guardModule(await importOriginal<object>(), 'claude-pty')
)

vi.mock('./claude-oauth-usage-request', () => ({
  fetchClaudeOAuthUsage: vi.fn()
}))

const fixtureRoot = path.join(__dirname, '__fixtures__', 'bound-claude-home')

function fixtureDir(name: string): string {
  return path.join(fixtureRoot, name)
}

function keychainPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token', ...overrides } })
}

beforeEach(() => {
  vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
  vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockReset()
  vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(null)
  ratchet.readPaths.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('fetchBoundClaudeHomeUsage', () => {
  it('reports ok from exactly one usage call for a valid token', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(okProvider('claude', 12))

    const result = await fetchBoundClaudeHomeUsage(fixtureDir('valid'))

    expect(result.status).toBe('ok')
    expect(result.rateLimits?.session?.usedPercent).toBe(12)
    expect(fetchClaudeOAuthUsage).toHaveBeenCalledTimes(1)
    expect(fetchClaudeOAuthUsage).toHaveBeenCalledWith('bound-access-token', undefined)
  })

  it('reports ok from the config-dir-scoped Keychain when the directory holds no file', async () => {
    // Why: a macOS Claude login writes the token to the Keychain and no `.credentials.json`, so a
    // file-only read renders a signed-in bound home as "Signed out" on Orca's primary platform.
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(keychainPayload())
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(okProvider('claude', 30))

    const result = await fetchBoundClaudeHomeUsage(fixtureDir('absent'))

    expect(result.status).toBe('ok')
    expect(fetchClaudeOAuthUsage).toHaveBeenCalledWith('keychain-token', undefined)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(fixtureDir('absent'))
  })

  it('reports expired for a lapsed Keychain token without any HTTP call', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      keychainPayload({ expiresAt: 1 })
    )

    const result = await fetchBoundClaudeHomeUsage(fixtureDir('absent'))

    expect(result).toEqual({ status: 'expired', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('falls back to the credentials file when the directory has no Keychain item', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(okProvider('claude', 7))

    await fetchBoundClaudeHomeUsage(fixtureDir('valid'))

    expect(fetchClaudeOAuthUsage).toHaveBeenCalledWith('bound-access-token', undefined)
  })

  it('reports expired without any HTTP call when the token has lapsed', async () => {
    const result = await fetchBoundClaudeHomeUsage(fixtureDir('expired'))

    expect(result).toEqual({ status: 'expired', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('reports signed-out without any HTTP call when the credentials file is absent', async () => {
    const result = await fetchBoundClaudeHomeUsage(fixtureDir('absent'))

    expect(result).toEqual({ status: 'signed-out', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('reports signed-out without any HTTP call when the file holds no access token', async () => {
    const result = await fetchBoundClaudeHomeUsage(fixtureDir('no-token'))

    expect(result).toEqual({ status: 'signed-out', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('reports unreadable without any HTTP call when the file is not valid JSON', async () => {
    const result = await fetchBoundClaudeHomeUsage(fixtureDir('unreadable'))

    expect(result).toEqual({ status: 'unreadable', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('stays signed-out when only the unscoped legacy Keychain item exists', async () => {
    // Why: the legacy `Claude Code-credentials` item belongs to the shared home. Letting it answer
    // for a bound directory renders the user's personal quota under the bound group's name.
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (configDir) =>
      configDir === undefined ? keychainPayload({ accessToken: 'personal-token' }) : null
    )
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(
      keychainPayload({ accessToken: 'personal-token' })
    )

    const result = await fetchBoundClaudeHomeUsage(fixtureDir('absent'))

    expect(result).toEqual({ status: 'signed-out', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('reports unreadable when the Keychain itself could not be reached', async () => {
    // Why: a Keychain Orca could not read is not evidence that the directory is signed out.
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockRejectedValue(new Error('denied'))

    const result = await fetchBoundClaudeHomeUsage(fixtureDir('absent'))

    expect(result).toEqual({ status: 'unreadable', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('propagates a usage-call failure instead of inventing a directory status', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValue(new Error('HTTP 500'))

    await expect(fetchBoundClaudeHomeUsage(fixtureDir('valid'))).rejects.toThrow('HTTP 500')
  })

  it('reads nothing outside the bound directory and writes nothing anywhere', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(okProvider('claude', 3))

    for (const fixture of ['valid', 'expired', 'absent', 'no-token', 'unreadable']) {
      const configDir = fixtureDir(fixture)
      await fetchBoundClaudeHomeUsage(configDir)
      const strayPaths = ratchet.readPaths.filter((read) => !read.startsWith(configDir))
      expect(strayPaths, `read outside ${fixture}`).toEqual([])
      expect(ratchet.readPaths.length).toBeGreaterThan(0)
      ratchet.readPaths.length = 0
    }
    // Every Keychain lookup is scoped to the directory under test, never to the active home.
    for (const call of vi.mocked(readActiveClaudeKeychainCredentialsStrict).mock.calls) {
      expect(call[0]?.startsWith(fixtureRoot)).toBe(true)
    }
  })
})
