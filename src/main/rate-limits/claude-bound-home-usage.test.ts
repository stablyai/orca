import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBoundClaudeHomeUsage } from './claude-bound-home-usage'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { okProvider } from './rate-limit-service-test-harness'

// Why: the D9 ratchet. Every filesystem call the bound-home path can reach is replaced; only
// the read verbs stay real, so a future edit that writes anything into a bound directory
// throws here instead of shipping. Keep this list read-only — never add a write verb.
const ratchet = vi.hoisted(() => {
  const readOnlyFsVerbs = new Set([
    'readFile',
    'readdir',
    'stat',
    'lstat',
    'access',
    'realpath',
    'opendir',
    'readlink'
  ])
  const guardModule = (
    actual: object,
    label: string,
    allowed: ReadonlySet<string> = new Set<string>()
  ): Record<string, unknown> => {
    const guarded: Record<string, unknown> = {}
    for (const name of Object.keys(actual)) {
      const value: unknown = Reflect.get(actual, name)
      if (typeof value !== 'function' || allowed.has(name)) {
        guarded[name] = value
        continue
      }
      guarded[name] = () => {
        throw new Error(`D9 violation: bound-home usage called ${label}.${name}`)
      }
    }
    return guarded
  }
  return { readOnlyFsVerbs, guardModule }
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

vi.mock('../claude-accounts/keychain', async (importOriginal) =>
  ratchet.guardModule(await importOriginal<object>(), 'keychain')
)

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

  it('propagates a usage-call failure instead of inventing a directory status', async () => {
    vi.mocked(fetchClaudeOAuthUsage).mockRejectedValue(new Error('HTTP 500'))

    await expect(fetchBoundClaudeHomeUsage(fixtureDir('valid'))).rejects.toThrow('HTTP 500')
  })

  it('reads nothing outside the bound directory and writes nothing anywhere', async () => {
    // Why: the ratchet. Every write verb on every module this path can reach throws, so a
    // credential stage, a Keychain write, a token refresh or a file write fails the suite.
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(okProvider('claude', 3))

    await expect(fetchBoundClaudeHomeUsage(fixtureDir('valid'))).resolves.toMatchObject({
      status: 'ok'
    })
    await expect(fetchBoundClaudeHomeUsage(fixtureDir('expired'))).resolves.toMatchObject({
      status: 'expired'
    })
    await expect(fetchBoundClaudeHomeUsage(fixtureDir('absent'))).resolves.toMatchObject({
      status: 'signed-out'
    })
  })
})
