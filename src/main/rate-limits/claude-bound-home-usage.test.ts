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
 *
 * `vi.mock` is specifier-exact and only reaches vitest's own module registry, so a guard list built
 * from the write verbs alone passes vacuously for any sink reached *around* that registry. Three
 * shapes do exactly that and the repo already spells each of them: a native module
 * (`await import('node-pty')`), Electron's unpatched fs behind `createRequire('original-fs')`
 * (`asar-transparent-fs`), and a second JS realm (`new Worker(...)`, whose module graph this file's
 * mocks never touch). They are guarded below for that reason, not because today's code reaches them.
 *
 * A token refresh has no filesystem sink at all — it is a network call that makes the bound
 * directory's own single-use refresh token dead server-side — so its sinks are guarded by specifier
 * too: `fetch` (a global, invisible to `vi.mock`), `node:https`, `node:http`, Electron's `net` —
 * the spelling `oauth-refresh.ts` uses — and the raw `node:net` / `node:tls` sockets underneath
 * them. `electron`'s `utilityProcess.fork` rides the same specifier and is guarded with them.
 *
 * The self-test at the bottom fires every probe, so dropping a mock or renaming a specifier fails
 * the suite instead of quietly widening what a bound directory is exposed to.
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
    // Covers both `execFile(command, args)` and `runProcess({ program, args })`. Reading the wrong
    // key would deny the allowed read too, which reads as "the ratchet forbids the supported
    // spawner" and pushes the next author toward `node:child_process` or toward loosening this.
    const spec = isPlainObject(args[0]) ? args[0] : { program: args[0], args: args[1] }
    const argv: unknown = Reflect.get(spec, 'args')
    return {
      command: String(Reflect.get(spec, 'program') ?? Reflect.get(spec, 'command')),
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

  /**
   * A module with no legitimate read on this path: every named export throws. Built without
   * `importOriginal` so guarding a native or Electron-only module never loads it.
   */
  const forbiddenModule = (label: string, names: readonly string[]): Record<string, unknown> => {
    const guarded: Record<string, unknown> = {}
    for (const name of names) {
      guarded[name] = () => {
        throw new Error(`D9 violation: bound-home usage called ${label}.${name}`)
      }
    }
    return guarded
  }

  return { readOnlyFsVerbs, guardModule, guardSpawnModule, forbiddenModule, readPaths }
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

// Why: a PTY spawn is one of the five writes this file names, and `claude-pty.ts` and
// `codex-pty-rate-limit-probe.ts` both reach it as `await import('node-pty')` — a specifier no
// `node:child_process` guard sees. Guarding `./claude-pty` guards the wrapper, not the sink.
vi.mock('node-pty', () => ratchet.forbiddenModule('node-pty', ['spawn', 'open']))

// Why: `asar-transparent-fs` resolves its `rm` through `createRequire(__filename)('original-fs')`,
// Electron's unpatched, fully write-capable fs. A recursive delete through it touches no `node:fs*`
// specifier.
vi.mock('../asar-transparent-fs', () => ratchet.forbiddenModule('asar-transparent-fs', ['rm']))

// Why: `createRequire` is the general form of that escape — it resolves outside vitest's registry,
// so `createRequire(__filename)('fs').writeFileSync` and `('original-fs')` alike land on the real
// module whatever is mocked above. Nothing on this path needs a CommonJS require.
vi.mock('node:module', async (importOriginal) => {
  const guarded = {
    ...(await importOriginal<object>()),
    ...ratchet.forbiddenModule('node:module', ['createRequire'])
  }
  return { ...guarded, default: guarded }
})

// Why: a token refresh is the fifth write this file's header names, and it is the one write with no
// filesystem sink at all — the server rotates a single-use refresh token and the copy still sitting
// in the bound directory dies. `vi.mock('../claude-accounts/oauth-refresh')` below guards the
// *wrapper*; the specifiers below are the sinks that wrapper and every other in-repo network call
// reach. A guard written against the verb name `refresh` would cover none of them.
//
// `fetch` is a global, not a module, so `vi.mock` cannot see it at all and only a stub reaches it.
vi.stubGlobal('fetch', () => {
  throw new Error('D9 violation: bound-home usage called global fetch')
})

vi.mock('node:https', async (importOriginal) => {
  const guarded = {
    ...(await importOriginal<object>()),
    ...ratchet.forbiddenModule('node:https', ['request', 'get'])
  }
  return { ...guarded, default: guarded }
})

vi.mock('node:http', async (importOriginal) => {
  const guarded = {
    ...(await importOriginal<object>()),
    ...ratchet.forbiddenModule('node:http', ['request', 'get'])
  }
  return { ...guarded, default: guarded }
})

// Why: `net.fetch` is the only sanctioned spelling in this repo — `proxy-guarded-fetch-call-site-audit`
// enforces it and `oauth-refresh.ts:142` uses it — so a copied refresh lands here, not on `fetch`.
// `utilityProcess.fork` rides the same specifier and is the `node:worker_threads` escape with a
// different name: a second process whose module graph none of these mocks reach, so it is guarded
// for the same reason the `Worker` constructor is. Built without `importOriginal` because outside an
// Electron process the real `electron` entry point is a path string, whose named imports are all
// `undefined` — which is how `net.request` was denied by a TypeError rather than by rule.
vi.mock('electron', () => {
  const guarded = {
    net: ratchet.forbiddenModule('electron.net', ['fetch', 'request', 'resolveHost']),
    utilityProcess: ratchet.forbiddenModule('electron.utilityProcess', ['fork'])
  }
  return { ...guarded, default: guarded }
})

// Why: `node:net` and `node:tls` are the same refresh one layer down — a hand-rolled POST on a raw
// socket touches no `http` specifier. No in-repo code spells an outbound request this way, so this
// guard is by rule, not by sighting, exactly like `node-pty` and `node:worker_threads`.
vi.mock('node:net', async (importOriginal) => {
  const guarded = {
    ...(await importOriginal<object>()),
    ...ratchet.forbiddenModule('node:net', ['connect', 'createConnection'])
  }
  return { ...guarded, default: guarded }
})

vi.mock('node:tls', async (importOriginal) => {
  const guarded = {
    ...(await importOriginal<object>()),
    ...ratchet.forbiddenModule('node:tls', ['connect', 'createConnection'])
  }
  return { ...guarded, default: guarded }
})

// Why: a worker runs its entry file in a second module registry, where none of this file's mocks
// apply — so any write inside it escapes every guard above. `usage-scan-worker-spawn.ts` is the
// in-repo spelling. Only the constructor is replaced; the module's data exports stay real.
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<object>()
  const guarded = {
    ...actual,
    Worker: class {
      constructor() {
        throw new Error('D9 violation: bound-home usage started a worker thread')
      }
    }
  }
  return { ...guarded, default: guarded }
})

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

  it('reports expired, not signed-out, when only a refresh token is left', async () => {
    // Why: this is the shape Claude leaves once an access token is consumed and cleared. "Signed
    // out" sends the user to a full `claude login`, which rotates the very token Orca is trying not
    // to disturb — re-running `claude` in that directory is all it needs.
    const result = await fetchBoundClaudeHomeUsage(fixtureDir('no-token'))

    expect(result).toEqual({ status: 'expired', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('reports expired when the scoped Keychain item holds only a refresh token', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { refreshToken: 'keychain-refresh' } })
    )

    const result = await fetchBoundClaudeHomeUsage(fixtureDir('absent'))

    expect(result).toEqual({ status: 'expired', rateLimits: null })
    expect(fetchClaudeOAuthUsage).not.toHaveBeenCalled()
  })

  it('reports signed-out without any HTTP call when the file holds no credentials at all', async () => {
    const result = await fetchBoundClaudeHomeUsage(fixtureDir('signed-out'))

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

  it('keeps every read this module makes itself inside the bound directory', async () => {
    // Scope of the claim: the reads this module performs *through a mocked module*. The macOS
    // Keychain entry point is stubbed, so its own `realpathSync`/`lstatSync` alias walk — which
    // deliberately climbs above the bound directory (`keychain.ts:133-177`) — does not run here and
    // is not covered by the path assertion below. Those are reads, which D9 permits; what matters
    // is which entry point is used and how it is called, asserted directly underneath.
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(okProvider('claude', 3))

    for (const fixture of ['valid', 'expired', 'absent', 'no-token', 'signed-out', 'unreadable']) {
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

  it('never reaches the Keychain through any entry point but the config-dir-scoped one', async () => {
    // Why this is the real guarantee: the strict reader is the only one that cannot fall back to
    // the unscoped `Claude Code-credentials` item. The path recorder above cannot see inside it,
    // so the narrow claim — one entry point, always scoped — is asserted here instead.
    vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(okProvider('claude', 3))

    for (const fixture of ['valid', 'expired', 'absent', 'no-token', 'signed-out', 'unreadable']) {
      await fetchBoundClaudeHomeUsage(fixtureDir(fixture))
    }

    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
    expect(vi.mocked(readActiveClaudeKeychainCredentialsStrict).mock.calls.length).toBeGreaterThan(
      0
    )
    for (const call of vi.mocked(readActiveClaudeKeychainCredentialsStrict).mock.calls) {
      expect(call[0]?.startsWith(fixtureRoot)).toBe(true)
    }
  })
})

/**
 * The probes, run rather than recorded. Each one is the shape a real mutation of
 * `fetchBoundClaudeHomeUsage` would take; a green suite with any of these passing means the ratchet
 * has stopped biting. Every guarded specifier gets exactly one probe.
 */
describe('the D9 ratchet itself', () => {
  const boundFile = path.join(fixtureDir('valid'), 'probe.json')
  const probeTokenUrl = 'https://platform.claude.com/v1/oauth/token'

  it('fails a file write into the bound directory', async () => {
    const fsPromises = await import('node:fs/promises')

    expect(() => fsPromises.writeFile(boundFile, '{}')).toThrow('D9 violation')
  })

  it('fails a file write reached through the nested `fs.promises` object', async () => {
    const fs = await import('node:fs')

    expect(() => fs.default.promises.writeFile(boundFile, '{}')).toThrow('D9 violation')
    expect(() => fs.writeFileSync(boundFile, '{}')).toThrow('D9 violation')
  })

  it('fails a Keychain item write however it is spawned, and allows only the read verb', async () => {
    const { execFile } = await import('node:child_process')
    const { runProcess } = await import('../../shared/child-process/run-process')

    expect(() =>
      execFile('security', ['add-generic-password', '-s', 'Claude Code-credentials'])
    ).toThrow('D9 violation')
    expect(() => runProcess({ program: 'security', args: ['delete-generic-password'] })).toThrow(
      'D9 violation'
    )
    // The allowed read has to stay allowed through the spawner the repo actually mandates.
    expect(() => execFile('security', ['find-generic-password', '-s', 'x'])).not.toThrow()
    expect(() =>
      runProcess({ program: 'security', args: ['find-generic-password', '-s', 'x'] })
    ).not.toThrow()
  })

  it('fails a Keychain write export and a credential stage', async () => {
    const keychain = await import('../claude-accounts/keychain')
    const refresh = await import('../claude-accounts/oauth-refresh')

    expect(() => keychain.writeActiveClaudeKeychainCredentials('{}')).toThrow('D9 violation')
    expect(() => keychain.deleteActiveClaudeKeychainCredentials()).toThrow('D9 violation')
    expect(Object.keys(refresh).length).toBeGreaterThan(0)
    for (const name of Object.keys(refresh)) {
      const exported: unknown = Reflect.get(refresh, name)
      if (typeof exported === 'function') {
        expect(() => exported()).toThrow('D9 violation')
      }
    }
  })

  it('fails a PTY spawn reached as a dynamic `node-pty` import', async () => {
    // The R1 probe: `claude-pty.ts` and `codex-pty-rate-limit-probe.ts` both spell it exactly this
    // way, so this is the shape a "reuse the PTY fetcher for parity" change would take.
    const pty = await import('node-pty')

    expect(() => pty.spawn('claude', ['/usage'], {})).toThrow('D9 violation')
  })

  it("fails a delete reached through Electron's unpatched `original-fs`", async () => {
    const asarFs = await import('../asar-transparent-fs')

    expect(() => asarFs.rm(fixtureDir('valid'), { recursive: true })).toThrow('D9 violation')
  })

  it('fails a CommonJS require, the general form of the `original-fs` escape', async () => {
    const { createRequire } = await import('node:module')

    expect(() => createRequire(__filename)).toThrow('D9 violation')
  })

  it('fails a worker thread, whose module graph none of these mocks reach', async () => {
    const { Worker } = await import('node:worker_threads')

    expect(() => new Worker('./writer.js')).toThrow('D9 violation')
  })

  it('fails a token refresh reached as global `fetch`', () => {
    expect(() => fetch(probeTokenUrl, { method: 'POST' })).toThrow('D9 violation')
  })

  it('fails a token refresh reached through `node:https` or `node:http`', async () => {
    const https = await import('node:https')
    const http = await import('node:http')

    expect(() => https.request({ host: '127.0.0.1', port: 9, method: 'POST' })).toThrow(
      'D9 violation'
    )
    expect(() => https.get({ host: '127.0.0.1', port: 9 })).toThrow('D9 violation')
    expect(() => http.request({ host: '127.0.0.1', port: 9, method: 'POST' })).toThrow(
      'D9 violation'
    )
    expect(() => http.get({ host: '127.0.0.1', port: 9 })).toThrow('D9 violation')
  })

  it("fails a token refresh reached through Electron's `net`, the in-repo spelling", async () => {
    // `oauth-refresh.ts:142` is `net.fetch(OAUTH_TOKEN_URL, { method: 'POST', ... })`, and
    // `proxy-guarded-fetch-call-site-audit.test.ts` makes that the only sanctioned spelling, so a
    // copied refresh lands here rather than on `fetch` or `node:https`.
    const { net } = await import('electron')

    expect(() => net.fetch(probeTokenUrl, { method: 'POST' })).toThrow('D9 violation')
    expect(() => net.request({ url: probeTokenUrl, method: 'POST' })).toThrow('D9 violation')
  })

  it('fails a hand-rolled request on a raw `node:net` or `node:tls` socket', async () => {
    const net = await import('node:net')
    const tls = await import('node:tls')

    expect(() => net.connect({ host: '127.0.0.1', port: 9 })).toThrow('D9 violation')
    expect(() => tls.connect({ host: '127.0.0.1', port: 9 })).toThrow('D9 violation')
  })

  it('fails a utilityProcess fork, the worker-thread escape under a second specifier', async () => {
    const { utilityProcess } = await import('electron')

    expect(() => utilityProcess.fork('./writer.js')).toThrow('D9 violation')
  })
})
