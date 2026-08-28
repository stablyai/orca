import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { listStaleCodexPanes } from './codex-stale-pane-accounts'
import type { CodexTrustEntry } from './config-toml-trust'

// STA-4823: six shared Codex state files were rebuilt, erased or reported as
// healthy after a read that had merely failed. Host permission failures drive
// four; the other guards cover transient transport and observation races.

const denials = vi.hoisted(() => {
  const state = {
    paths: new Set<string>(),
    readOnlyPaths: new Set<string>(),
    existenceDeniedPaths: new Set<string>(),
    deny(path: string): void {
      state.paths.add(path)
    },
    /**
     * Content reads fail but `existsSync` and metadata reads still succeed —
     * the measured host permission/sharing-denial shape.
     */
    denyReads(path: string): void {
      state.readOnlyPaths.add(path)
    },
    /**
     * `existsSync` reports false while the path is still there, and the write
     * still lands.
     *
     * MEASURED, and not what I first assumed: a file-permission denial does NOT
     * produce this. `chmod 000` on macOS and `icacls /deny (R)` on Windows both
     * leave `existsSync` TRUE, leave `stat`/`lstat` succeeding, and fail only
     * the content read (EACCES / EPERM errno -4048). The shape modelled here is
     * a transient transport failure: a UNC / `\\wsl$` probe reports errno
     * `UNKNOWN`, `existsSync` folds it to false, and the transport recovers
     * before the following write.
     *
     * The distinction decides what the guard is worth: under a permission denial
     * the pre-fix code already failed safe, because `existsSync` was true so it
     * took the read branch and threw. Only a transport that lies about existence
     * reaches the rebuild-from-empty path.
     */
    denyExistence(path: string): void {
      state.existenceDeniedPaths.add(path)
    },
    release(path: string): void {
      state.paths.delete(path)
      state.readOnlyPaths.delete(path)
      state.existenceDeniedPaths.delete(path)
    },
    reset(): void {
      state.paths.clear()
      state.readOnlyPaths.clear()
      state.existenceDeniedPaths.clear()
    },
    check(target: unknown, syscall: string, readOnly = false): void {
      if (typeof target !== 'string') {
        return
      }
      const readDenied =
        readOnly && (state.readOnlyPaths.has(target) || state.existenceDeniedPaths.has(target))
      if (!state.paths.has(target) && !readDenied) {
        return
      }
      const error: NodeJS.ErrnoException = new Error(
        `EPERM: operation not permitted, ${syscall} '${target}'`
      )
      error.code = 'EPERM'
      error.errno = -4048
      error.syscall = syscall
      error.path = target
      throw error
    }
  }
  return state
})

// One denial modelled coherently: a denied path throws from every read AND
// reports false from existsSync. Faulting one but not another lets a test pass
// against code that still consults the one left healthy.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const guard = (fn: unknown, syscall: string): unknown => {
    const original = fn as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown => {
      denials.check(args[0], syscall)
      return original(...args)
    }
    return Object.assign(wrapped, original)
  }
  const patched: Record<string, unknown> = {
    ...actual,
    readFileSync: Object.assign((...args: unknown[]): unknown => {
      denials.check(args[0], 'read', true)
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args)
    }, actual.readFileSync),
    // Why: the size-capped agent-state reader opens with `openSync`, so leaving
    // it unguarded makes a denial invisible to every config/baseline read. Guard
    // it for READ intent only — a write opens 'w'/'wx'/'a', and the atomic
    // replace those writes perform must stay healthy (see `deny` above).
    openSync: Object.assign((...args: unknown[]): unknown => {
      const flags = args[1]
      const isRead = flags === undefined || (typeof flags === 'string' && flags.startsWith('r'))
      if (isRead) {
        denials.check(args[0], 'open', true)
      }
      return (actual.openSync as (...a: unknown[]) => unknown)(...args)
    }, actual.openSync),
    statSync: guard(actual.statSync, 'stat'),
    lstatSync: guard(actual.lstatSync, 'lstat'),
    existsSync: Object.assign(
      (...args: unknown[]): boolean =>
        typeof args[0] === 'string' &&
        (denials.paths.has(args[0]) || denials.existenceDeniedPaths.has(args[0]))
          ? false
          : actual.existsSync(args[0] as string),
      actual.existsSync
    )
  }
  return { ...patched, default: patched }
})

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

const realFs = await vi.importActual<typeof NodeFs>('node:fs')

const { upsertHookTrustEntries, upsertProjectTrustLevel, readHookTrustEntries } =
  await import('./config-toml-trust')
const {
  writeCodexTrustGrantLedgerHome,
  readCodexTrustGrantLedgerHome,
  getCodexTrustGrantLedgerPath
} = await import('./codex-trust-grant-ledger')
const { readHooksJson } = await import('../agent-hooks/hooks-json-read')
const { MAX_AGENT_STATE_FILE_BYTES } = await import('../agent-state-file-reader')
const { observeCodexSettingsBaseline } = await import('./config-settings-baseline')
const { snapshotCodexRuntimeSettingsBaseline } = await import('./config-settings-promotion')
const { getCodexConfigSyncStatus } = await import('./config-sync-stall')
const paneRegistry = await import('./codex-pane-account-registry')

let fakeHomeDir: string
let userDataDir: string
let runtimeHomePath: string
let previousUserDataPath: string | undefined

const systemHome = (): string => join(fakeHomeDir, '.codex')
const baselinePath = (): string => join(runtimeHomePath, '.orca-config-settings-baseline.json')

beforeEach(() => {
  denials.reset()
  fakeHomeDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4823-home-'))
  userDataDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4823-data-'))
  runtimeHomePath = join(userDataDir, 'codex-runtime-home', 'home')
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  realFs.mkdirSync(runtimeHomePath, { recursive: true })
  realFs.mkdirSync(systemHome(), { recursive: true })
  paneRegistry._internals.resetCache()
})

afterEach(() => {
  denials.reset()
  paneRegistry._internals.resetCache()
  realFs.rmSync(fakeHomeDir, { recursive: true, force: true })
  realFs.rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('STA-4823 D29 — an unreadable config.toml must not become a trust-only stub', () => {
  const USER_CONFIG = [
    'model = "gpt-5.1-codex-max"',
    'model_provider = "openai"',
    '',
    '# my notes',
    '[mcp_servers.local]',
    'command = "run-me"',
    ''
  ].join('\n')
  const ENTRY = [
    {
      sourcePath: '/tmp/hooks.json',
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'orca hook',
      trustedHash: 'sha256:x',
      enabled: true
    }
  ] satisfies readonly CodexTrustEntry[]

  it('refuses the write rather than rebuilding the file from the trust entries alone', () => {
    const configPath = join(runtimeHomePath, 'config.toml')
    realFs.writeFileSync(configPath, USER_CONFIG, 'utf-8')
    denials.denyExistence(configPath)

    // Every hook-service caller already turns this throw into "trust entries
    // could not be written. Run /hooks in Codex to approve."
    expect(() => upsertHookTrustEntries(configPath, ENTRY)).toThrow('EPERM')

    // Before the fix, existsSync said the file was gone, `existing` became '',
    // and the upsert wrote a config containing ONLY the trust table — the
    // user's model, provider, MCP servers and comments all discarded.
    expect(realFs.readFileSync(configPath, 'utf-8')).toBe(USER_CONFIG)
  })

  it('still seeds a config.toml that does not exist yet', () => {
    const configPath = join(runtimeHomePath, 'config.toml')

    // Why: seeding from empty is correct for a genuine absence, and is how a
    // fresh managed home gets its trust entries at all.
    upsertHookTrustEntries(configPath, ENTRY)

    expect(readHookTrustEntries(configPath).size).toBeGreaterThan(0)
  })

  it('also refuses a project-trust write when the existing config cannot be read', () => {
    const configPath = join(runtimeHomePath, 'config.toml')
    realFs.writeFileSync(configPath, USER_CONFIG, 'utf-8')
    denials.denyExistence(configPath)

    expect(() => upsertProjectTrustLevel(configPath, '/tmp/project', 'trusted')).toThrow('EPERM')
    expect(realFs.readFileSync(configPath, 'utf-8')).toBe(USER_CONFIG)
  })

  it('still seeds project trust when config.toml is genuinely absent', () => {
    const configPath = join(runtimeHomePath, 'config.toml')

    upsertProjectTrustLevel(configPath, '/tmp/project', 'trusted')

    expect(realFs.readFileSync(configPath, 'utf-8')).toContain('trust_level = "trusted"')
  })
})

describe('STA-4823 D30 — an unreadable trust-grant ledger must not be rewritten from empty', () => {
  const OTHER_HOME = '/some/other/managed/home'

  function seedLedgerWithAnotherHome(): string {
    const ledgerPath = getCodexTrustGrantLedgerPath()
    writeCodexTrustGrantLedgerHome(
      OTHER_HOME,
      { entries: { 'a:b': { trustedHash: 'sha256:other' } } } as never,
      ledgerPath
    )
    return ledgerPath
  }

  it('skips the write instead of dropping every other home', () => {
    const ledgerPath = seedLedgerWithAnotherHome()
    const before = realFs.readFileSync(ledgerPath, 'utf-8')
    denials.denyReads(ledgerPath)

    writeCodexTrustGrantLedgerHome(
      runtimeHomePath,
      { entries: { 'c:d': { trustedHash: 'sha256:mine' } } } as never,
      ledgerPath
    )

    // Before the fix the read degraded to an empty ledger and the write
    // persisted a file holding only this home, so every other home lost its
    // grants and would be re-prompted for trust it had already given.
    expect(realFs.readFileSync(ledgerPath, 'utf-8')).toBe(before)
  })

  it('still records a home when the ledger is readable', () => {
    const ledgerPath = seedLedgerWithAnotherHome()

    // Why: the anchor. Refusing whenever a read fails would stop the ledger
    // ever recording a grant.
    writeCodexTrustGrantLedgerHome(
      runtimeHomePath,
      { entries: { 'c:d': { trustedHash: 'sha256:mine' } } } as never,
      ledgerPath
    )

    expect(readCodexTrustGrantLedgerHome(runtimeHomePath, ledgerPath)).not.toBeNull()
    expect(readCodexTrustGrantLedgerHome(OTHER_HOME, ledgerPath)).not.toBeNull()
  })
})

describe('STA-4823 D33 — an unreadable hooks.json is not an empty hooks.json', () => {
  it('reports a failed read as unknown rather than as no hooks configured', () => {
    const hooksPath = join(runtimeHomePath, 'hooks.json')
    realFs.writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [] } }), 'utf-8')
    denials.deny(hooksPath)

    // The read arm already returned null for a failed read; the existsSync arm
    // in front of it returned a VALID EMPTY config, and the installer then
    // wrote generated hooks over the user's file.
    expect(readHooksJson(hooksPath)).toBeNull()
  })

  it('still reports a genuinely absent hooks.json as an empty config', () => {
    // Why: absence really does mean "no hooks configured", and the installer
    // depends on that to seed one.
    expect(readHooksJson(join(runtimeHomePath, 'hooks.json'))).toEqual({})
  })
})

describe('STA-4823 D26 — an unreadable settings baseline must stall the mirror', () => {
  function seedBaseline(): string {
    realFs.writeFileSync(
      baselinePath(),
      `${JSON.stringify({ version: 2, settings: { model: 'old-model' } })}\n`,
      'utf-8'
    )
    return realFs.readFileSync(baselinePath(), 'utf-8')
  }

  it('preserves the pending runtime edit until the baseline can be read', () => {
    const before = seedBaseline()
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    realFs.writeFileSync(runtimeConfigPath, 'model = "edited-in-codex"\n', 'utf-8')
    realFs.writeFileSync(join(systemHome(), 'config.toml'), 'model = "old-model"\n', 'utf-8')
    denials.denyReads(baselinePath())

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath: systemHome() })

    // Before the fix the failed baseline read became "no baseline", promotion
    // returned an empty plan, and the mirror wrote the old system value over
    // the pending in-Codex edit.
    expect(realFs.readFileSync(runtimeConfigPath, 'utf-8')).toContain('edited-in-codex')
    expect(realFs.readFileSync(baselinePath(), 'utf-8')).toBe(before)
  })

  it('does not replace a baseline after an indeterminate existence probe', () => {
    const before = seedBaseline()
    realFs.writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "edited"\n', 'utf-8')
    denials.denyExistence(baselinePath())

    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)

    expect(realFs.readFileSync(baselinePath(), 'utf-8')).toBe(before)
  })

  it('still replaces a baseline that is present but malformed', () => {
    realFs.writeFileSync(baselinePath(), '{ not json', 'utf-8')
    realFs.writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "m"\n', 'utf-8')

    // Why: a corrupt baseline carries no information and resetting it IS the
    // intent. Only the unreadable case may be preserved, or a user is wedged
    // on a broken file forever.
    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)

    // Asserted against the file rather than the new observation API, so this
    // anchor still means something when the fix is reverted.
    expect(JSON.parse(realFs.readFileSync(baselinePath(), 'utf-8'))).toMatchObject({ version: 2 })
  })

  it('still replaces a fully-read baseline rejected by the JSON structure limit', () => {
    realFs.writeFileSync(baselinePath(), '['.repeat(129), 'utf-8')
    realFs.writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "m"\n', 'utf-8')

    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)

    expect(JSON.parse(realFs.readFileSync(baselinePath(), 'utf-8'))).toMatchObject({ version: 2 })
  })

  it('rebuilds an oversized baseline previously produced from a bounded runtime config', () => {
    const escapedValue = '\\'.repeat(MAX_AGENT_STATE_FILE_BYTES / 2 + 64)
    const oversizedRuntimeConfig = `model = "${escapedValue}"\n`
    expect(Buffer.byteLength(oversizedRuntimeConfig)).toBeLessThan(MAX_AGENT_STATE_FILE_BYTES)
    realFs.writeFileSync(join(runtimeHomePath, 'config.toml'), oversizedRuntimeConfig, 'utf-8')

    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)
    expect(realFs.statSync(baselinePath()).size).toBeGreaterThan(MAX_AGENT_STATE_FILE_BYTES)
    expect(observeCodexSettingsBaseline(runtimeHomePath)).toEqual({ kind: 'absent' })

    realFs.writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "recovered"\n', 'utf-8')
    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)

    expect(realFs.statSync(baselinePath()).size).toBeLessThan(MAX_AGENT_STATE_FILE_BYTES)
    expect(JSON.parse(realFs.readFileSync(baselinePath(), 'utf-8'))).toMatchObject({
      settings: { model: '"recovered"' }
    })
  })
})

describe('STA-4823 D15 — the sync status must not report synced while the mirror refuses', () => {
  it('reports the managed home as unavailable when its config cannot be read', () => {
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    realFs.writeFileSync(runtimeConfigPath, 'model = "m"\n', 'utf-8')
    realFs.writeFileSync(join(systemHome(), 'config.toml'), 'model = "s"\n', 'utf-8')
    denials.deny(runtimeConfigPath)

    const status = getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath: systemHome() })

    // Before the fix existsSync collapsed this failed observation into absence
    // and returned `synced` — telling the user their edits had been applied
    // while nothing had run.
    expect(status).toMatchObject({ state: 'stalled', reason: 'managed-home-unavailable' })
  })

  it('reports the managed home as unavailable when only its content read is denied', () => {
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    realFs.writeFileSync(runtimeConfigPath, 'model = "m"\n', 'utf-8')
    realFs.writeFileSync(join(systemHome(), 'config.toml'), 'model = "s"\n', 'utf-8')
    denials.denyReads(runtimeConfigPath)

    expect(
      getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath: systemHome() })
    ).toMatchObject({ state: 'stalled', reason: 'managed-home-unavailable' })
  })

  it('still reports synced when no runtime config exists yet', () => {
    realFs.writeFileSync(join(systemHome(), 'config.toml'), 'model = "s"\n', 'utf-8')

    // Why: with no managed config the mirror seeds one; there is nothing to
    // have fallen behind, and warning here would fire on every fresh install.
    expect(
      getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath: systemHome() })
    ).toMatchObject({ state: 'synced', reason: null })
  })
})

describe('STA-4823 D31 — an unreadable pane registry must not erase every attribution', () => {
  const PANE = 'pty-1'
  const OTHER_PANE = 'pty-2'
  const registryPath = (): string => join(userDataDir, 'codex-pane-accounts.json')

  function seedTwoAttributedPanes(): void {
    paneRegistry.recordCodexPaneAccount(PANE, {
      selectionKey: 'host',
      accountId: 'account-1',
      homeRoute: 'account-home'
    } as never)
    paneRegistry.recordCodexPaneAccount(OTHER_PANE, {
      selectionKey: 'host',
      accountId: 'account-2',
      homeRoute: 'account-home'
    } as never)
    paneRegistry._internals.resetCache()
  }

  it('preserves existing records and retries the one-shot spawn mutation', () => {
    seedTwoAttributedPanes()
    const before = realFs.readFileSync(registryPath(), 'utf-8')
    denials.denyReads(registryPath())

    paneRegistry.recordCodexPaneAccount('pty-3', {
      selectionKey: 'host',
      accountId: 'account-3',
      homeRoute: 'account-home'
    } as never)

    // Before the fix the read degraded to an empty registry and this write
    // persisted it, dropping every other pane's account attribution on disk.
    expect(realFs.readFileSync(registryPath(), 'utf-8')).toBe(before)

    denials.release(registryPath())
    expect(paneRegistry.getCodexPaneAccount('pty-3')).toMatchObject({ accountId: 'account-3' })
    paneRegistry._internals.resetCache()
    expect(paneRegistry.getCodexPaneAccount(PANE)).toMatchObject({ accountId: 'account-1' })
    expect(paneRegistry.getCodexPaneAccount('pty-3')).toMatchObject({ accountId: 'account-3' })
  })

  it('does not cache the erasure, so attribution returns when the file does', () => {
    seedTwoAttributedPanes()
    denials.denyReads(registryPath())

    expect(paneRegistry.getCodexPaneAccount(PANE)).toBeNull()
    expect(() =>
      listStaleCodexPanes({
        ptyIds: [PANE],
        settings: { activeCodexManagedAccountId: 'account-2' } as never
      })
    ).toThrow('registry could not be read')

    denials.release(registryPath())

    // THE CACHE is the second half of this defect: one unreadable read used to
    // pin the empty registry in memory for the rest of the process, so the
    // attribution never came back even after the file did.
    expect(paneRegistry.getCodexPaneAccount(PANE)).toMatchObject({ accountId: 'account-1' })
  })

  it('still reports no attribution when the registry genuinely does not exist', () => {
    // Why: a fresh install has no registry, and that really is "no panes are
    // attributed". Refusing here would make every first launch look degraded.
    expect(paneRegistry.getCodexPaneAccount(PANE)).toBeNull()
  })
})
