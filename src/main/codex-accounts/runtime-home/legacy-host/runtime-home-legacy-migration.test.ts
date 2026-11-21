import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  existsSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createManagedAuth,
  createStore,
  getLegacyActiveHostCodexHomePath,
  getRuntimeCodexHomePath,
  getSystemCodexAuthPath,
  normalizeLinkTarget,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

const trackMock = vi.hoisted(() => vi.fn())
vi.mock('../../../telemetry/client', () => ({ track: trackMock }))

function trackedImportOutcomes(): string[] {
  return trackMock.mock.calls
    .filter(([event]) => event === 'codex_legacy_history_import')
    .map(([, props]: unknown[]) =>
      props && typeof props === 'object' && 'outcome' in props ? String(props.outcome) : ''
    )
}

function writeHistory(accountId: string, contents: string): string {
  const managedHomePath = createManagedAuth(
    testState.userDataDir,
    accountId,
    '{"account":"managed"}\n'
  )
  writeFileSync(join(managedHomePath, 'history.jsonl'), contents, 'utf-8')
  return managedHomePath
}

function blockSessionCopies(managedHomePath: string): void {
  // A file where a session folder must go: the session copy throws.
  mkdirSync(join(managedHomePath, 'sessions', 'nested'), { recursive: true })
  writeFileSync(join(managedHomePath, 'sessions', 'nested', 'rollout.jsonl'), '{}', 'utf-8')
  mkdirSync(join(getRuntimeCodexHomePath(), 'sessions'), { recursive: true })
  writeFileSync(join(getRuntimeCodexHomePath(), 'sessions', 'nested'), 'not a folder', 'utf-8')
}

function migrationMarkerPath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'migration-v1.json')
}

async function waitForImportOutcomes(outcomes: string[]): Promise<void> {
  await vi.waitFor(() => expect(trackedImportOutcomes()).toEqual(outcomes), { timeout: WAIT_MS })
}

async function constructService(): Promise<void> {
  const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements what the service reads.
  new CodexRuntimeHomeService(createStore(createSettings()) as never)
}

async function startService(): Promise<void> {
  await constructService()
  await waitForHistorySettled()
}

// Settled: the history import landed or was skipped, so nothing more is owed.
async function waitForHistorySettled(): Promise<void> {
  await vi.waitFor(
    () =>
      expect(readFileSync(historyStatePath(), 'utf-8')).toContain('"historyImportSettled":true'),
    { timeout: WAIT_MS }
  )
}

function historyStatePath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'migration-v1-history.json')
}

// Slow CI hosts take seconds to construct the service.
const WAIT_MS = 20_000

async function removeAccountHome(managedHomePath: string): Promise<void> {
  const { CodexManagedHomeLifecycle } =
    await import('../../managed-homes/codex-managed-home-lifecycle')
  const { CodexManagedHomePath } = await import('../../managed-homes/codex-managed-home-path')
  await new CodexManagedHomeLifecycle(new CodexManagedHomePath()).safeRemove(
    managedHomePath,
    'account-1'
  )
}

const fsHooks = vi.hoisted(
  (): {
    afterRead: Map<string, () => void>
    linkError: NodeJS.ErrnoException | null
    failedCopies: Set<string>
  } => ({
    afterRead: new Map(),
    linkError: null,
    failedCopies: new Set()
  })
)
vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal()
  const copyFileSync = (...args: Parameters<typeof actual.copyFileSync>): void => {
    if (fsHooks.failedCopies.has(String(args[1]))) {
      throw Object.assign(new Error('copy failed'), { code: 'EIO' })
    }
    actual.copyFileSync(...args)
  }
  return { ...actual, default: { ...actual, copyFileSync }, copyFileSync }
})
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every overload unchanged.
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const contents = await actual.readFile(...args)
    fsHooks.afterRead.get(String(args[0]))?.()
    return contents
  }) as typeof actual.readFile
  const link = async (...args: Parameters<typeof actual.link>): Promise<void> => {
    if (fsHooks.linkError) {
      throw fsHooks.linkError
    }
    await actual.link(...args)
  }
  return { ...actual, default: { ...actual, readFile, link }, readFile, link }
})

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexRuntimeHomeService', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    fsHooks.afterRead.clear()
    fsHooks.linkError = null
    fsHooks.failedCopies.clear()
    trackMock.mockClear()
    teardownRuntimeHomeTest()
  })

  it('repoints legacy active host CODEX_HOME to the shared runtime home on startup', async () => {
    const legacyLaunchHomePath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'launch',
      'host',
      'account-old',
      'home'
    )
    const legacyActiveHomePath = getLegacyActiveHostCodexHomePath()
    mkdirSync(legacyLaunchHomePath, { recursive: true })
    mkdirSync(join(legacyActiveHomePath, '..'), { recursive: true })
    symlinkSync(
      legacyLaunchHomePath,
      legacyActiveHomePath,
      process.platform === 'win32' ? 'junction' : undefined
    )
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    await waitForHistorySettled()

    expect(normalizeLinkTarget(readlinkSync(legacyActiveHomePath))).toBe(
      normalizeLinkTarget(getRuntimeCodexHomePath())
    )
    expect(readFileSync(join(legacyActiveHomePath, 'auth.json'), 'utf-8')).toBe(
      '{"account":"system"}\n'
    )
  })

  it('creates the shared history from legacy histories when none exists', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    writeHistory('account-1', '{"id":"a-1"}\n{"id":"both"}\n')
    writeHistory('account-2', '{"id":"both"}\n{"id":"b-1"}\n')

    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe(
      '{"id":"a-1"}\n{"id":"both"}\n{"id":"b-1"}\n'
    )
    expect(trackedImportOutcomes()).toEqual(['imported'])
  })

  it('imports a linked account history and ignores an account folder without a home folder', async () => {
    const elsewhere = join(testState.userDataDir, 'elsewhere-history.jsonl')
    writeFileSync(elsewhere, '{"id":"linked-1"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    symlinkSync(elsewhere, join(managedHomePath, 'history.jsonl'))
    const orphan = join(testState.userDataDir, 'codex-accounts', 'orphan')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'home'), 'not a folder', 'utf-8')

    await startService()

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"linked-1"}\n'
    )
    expect(readFileSync(elsewhere, 'utf-8')).toBe('{"id":"linked-1"}\n')
  })

  it('never writes an existing shared history, and account removal keeps the account history', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    writeFileSync(runtimeHistoryPath, '{"id":"shared-1"}', 'utf-8')
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')

    await startService()
    await removeAccountHome(managedHomePath)

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"shared-1"}')
    expect(trackedImportOutcomes()).toEqual(['skipped_existing'])
    expect(readFileSync(join(managedHomePath, 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"legacy-1"}\n'
    )
  })

  it('imports history even when a session copy fails, and retries the sessions next launch', async () => {
    const managedHomePath = writeHistory('account-1', '{"id":"a-1"}\n')
    blockSessionCopies(managedHomePath)

    await constructService()
    await waitForImportOutcomes(['imported'])

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"a-1"}\n'
    )
    expect(existsSync(migrationMarkerPath())).toBe(false)
    expect(readFileSync(historyStatePath(), 'utf-8')).toContain('"sessionPassAttempts":1')

    rmSync(join(getRuntimeCodexHomePath(), 'sessions', 'nested'))
    vi.resetModules()
    await startService()

    expect(
      readFileSync(join(getRuntimeCodexHomePath(), 'sessions', 'nested', 'rollout.jsonl'), 'utf-8')
    ).toBe('{}')
    expect(existsSync(migrationMarkerPath())).toBe(true)
  })

  it('waits a day before another session pass after three failed ones', async () => {
    const managedHomePath = writeHistory('account-1', '{"id":"a-1"}\n')
    mkdirSync(join(managedHomePath, 'sessions'), { recursive: true })
    writeFileSync(join(managedHomePath, 'sessions', 'rollout.jsonl'), '{}', 'utf-8')
    mkdirSync(join(historyStatePath(), '..'), { recursive: true })
    writeFileSync(
      historyStatePath(),
      // Failed later than any test clock: the day hasn't passed.
      JSON.stringify({ sessionPassAttempts: 3, sessionPassFailedAt: Number.MAX_SAFE_INTEGER }),
      'utf-8'
    )

    await startService()

    expect(existsSync(join(getRuntimeCodexHomePath(), 'sessions', 'rollout.jsonl'))).toBe(false)
    expect(existsSync(migrationMarkerPath())).toBe(false)
  })

  it('keeps no conflict copy while a session pass fails, then the latest bytes once it succeeds', async () => {
    const runtimeSessionsDir = join(getRuntimeCodexHomePath(), 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'session.json'), '{"runtime":1}', 'utf-8')
    const managedHomePath = writeHistory('account-1', '{"id":"a-1"}\n')
    mkdirSync(join(managedHomePath, 'sessions'), { recursive: true })
    writeFileSync(join(managedHomePath, 'sessions', 'session.json'), '{"legacy":1}', 'utf-8')
    blockSessionCopies(writeHistory('account-2', '{"id":"b-1"}\n'))
    await constructService()
    await waitForImportOutcomes(['imported'])
    writeFileSync(join(managedHomePath, 'sessions', 'session.json'), '{"legacy":2}', 'utf-8')
    vi.resetModules()
    await constructService()

    expect(readdirSync(runtimeSessionsDir).sort()).toEqual(['nested', 'session.json'])

    rmSync(join(runtimeSessionsDir, 'nested'))
    vi.resetModules()
    await constructService()

    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1.json'), 'utf-8')
    ).toBe('{"legacy":2}')
    expect(existsSync(migrationMarkerPath())).toBe(true)
  })

  it('leaves no conflict copy behind when keeping another conflict fails', async () => {
    const runtimeSessionsDir = join(getRuntimeCodexHomePath(), 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'a.json'), '{"runtime":"a"}', 'utf-8')
    writeFileSync(join(runtimeSessionsDir, 'b.json'), '{"runtime":"b"}', 'utf-8')
    const managedHomePath = writeHistory('account-1', '{"id":"a-1"}\n')
    mkdirSync(join(managedHomePath, 'sessions'), { recursive: true })
    writeFileSync(join(managedHomePath, 'sessions', 'a.json'), '{"legacy":"a"}', 'utf-8')
    writeFileSync(join(managedHomePath, 'sessions', 'b.json'), '{"legacy":"b"}', 'utf-8')
    fsHooks.failedCopies.add(join(runtimeSessionsDir, 'b.orca-legacy-account-1.json'))

    await constructService()
    await waitForImportOutcomes(['imported'])

    expect(readdirSync(runtimeSessionsDir).sort()).toEqual(['a.json', 'b.json'])
    expect(existsSync(migrationMarkerPath())).toBe(false)
  })

  it('removes the copy an interrupted import left behind', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    const leftover = `${runtimeHistoryPath}.4242.0b6f3c1e-2d4a-4b8e-9f10-7a6c5d4e3f21.orca-import.tmp`
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writeFileSync(leftover, '{"id":"half', 'utf-8')
    writeHistory('account-1', '{"id":"legacy-1"}\n')

    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"legacy-1"}\n')
    expect(existsSync(leftover)).toBe(false)
  })

  it('leaves a shared history Codex creates during the import as it is', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')
    fsHooks.afterRead.set(join(managedHomePath, 'history.jsonl'), () =>
      writeFileSync(runtimeHistoryPath, '{"id":"codex-new"}\n', 'utf-8')
    )

    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"codex-new"}\n')
    expect(trackedImportOutcomes()).toEqual(['skipped_existing'])
  })

  it('writes no shared history where hard links are refused, and keeps the account history', async () => {
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')
    fsHooks.linkError = Object.assign(new Error('no hard links'), { code: 'ENOTSUP' })

    await startService()

    expect(existsSync(join(getRuntimeCodexHomePath(), 'history.jsonl'))).toBe(false)
    expect(trackedImportOutcomes()).toEqual(['skipped_no_hard_links'])
    expect(readFileSync(join(managedHomePath, 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"legacy-1"}\n'
    )
  })

  it('retries only the failed history import on the next launch, not the session copies', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')
    fsHooks.afterRead.set(join(managedHomePath, 'history.jsonl'), () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    await constructService()
    await waitForImportOutcomes(['failed'])
    await vi.waitFor(
      () =>
        expect(readFileSync(historyStatePath(), 'utf-8')).toContain('"historyImportAttempts":1'),
      { timeout: WAIT_MS }
    )
    expect(existsSync(runtimeHistoryPath)).toBe(false)
    fsHooks.afterRead.clear()
    mkdirSync(join(managedHomePath, 'sessions'), { recursive: true })
    writeFileSync(join(managedHomePath, 'sessions', 'later.jsonl'), '{}', 'utf-8')

    vi.resetModules()
    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"legacy-1"}\n')
    expect(trackedImportOutcomes()).toEqual(['failed', 'imported'])
    expect(existsSync(join(getRuntimeCodexHomePath(), 'sessions', 'later.jsonl'))).toBe(false)
  })

  it('retries an import it gave up on once the account history changed', async () => {
    writeHistory('account-1', '{"id":"legacy-1"}\n')
    mkdirSync(join(historyStatePath(), '..'), { recursive: true })
    writeFileSync(
      historyStatePath(),
      JSON.stringify({ historyImportAttempts: 3, historyImportInputs: 'before the change' }),
      'utf-8'
    )

    await startService()

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"legacy-1"}\n'
    )
  })

  it('retries an import it gave up on a day later when nothing changed', async () => {
    writeHistory('account-1', '{"id":"legacy-1"}\n')
    const { legacyHistoryInputsKey } = await import('./legacy-prompt-history-import')
    mkdirSync(join(historyStatePath(), '..'), { recursive: true })
    writeFileSync(
      historyStatePath(),
      JSON.stringify({
        historyImportAttempts: 3,
        historyImportInputs: await legacyHistoryInputsKey(
          join(testState.userDataDir, 'codex-accounts')
        ),
        historyImportGaveUpAt: 0
      }),
      'utf-8'
    )

    await startService()

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"legacy-1"}\n'
    )
  })

  it('does not re-run migration when marker already exists', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')
    await startService()
    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"legacy-1"}\n')

    writeFileSync(
      join(managedHomePath, 'history.jsonl'),
      '{"id":"legacy-1"}\n{"id":"legacy-2"}\n',
      'utf-8'
    )
    vi.resetModules()
    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"legacy-1"}\n')
  })

  it('preserves conflicting legacy session files under deterministic names', async () => {
    const runtimeSessionsDir = join(getRuntimeCodexHomePath(), 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'session.json'), '{"turns":[1]}', 'utf-8')
    mkdirSync(join(runtimeSessionsDir, 'nested'), { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'nested', 'session.json'), '{"turns":[2]}', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const legacySessionsDir = join(managedHomePath, 'sessions')
    mkdirSync(legacySessionsDir, { recursive: true })
    writeFileSync(join(legacySessionsDir, 'session.json'), '{"turns":[1,2]}', 'utf-8')
    mkdirSync(join(legacySessionsDir, 'nested'), { recursive: true })
    writeFileSync(join(legacySessionsDir, 'nested', 'session.json'), '{"turns":[2,3]}', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    await waitForHistorySettled()

    expect(readFileSync(join(runtimeSessionsDir, 'session.json'), 'utf-8')).toBe('{"turns":[1]}')
    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1.json'), 'utf-8')
    ).toBe('{"turns":[1,2]}')
    expect(
      readFileSync(
        join(runtimeSessionsDir, 'nested', 'session.orca-legacy-account-1.json'),
        'utf-8'
      )
    ).toBe('{"turns":[2,3]}')
    const diagnostics = readFileSync(
      join(testState.userDataDir, 'codex-runtime-home', 'migration-diagnostics.jsonl'),
      'utf-8'
    )
      .trim()
      .split('\n')
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toContain('"type":"session-conflict"')
  })

  it('never overwrites an existing preserved session copy', async () => {
    const runtimeSessionsDir = join(getRuntimeCodexHomePath(), 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    writeFileSync(join(runtimeSessionsDir, 'session.json'), '{"turns":[1]}', 'utf-8')
    const occupiedPreservedPath = join(runtimeSessionsDir, 'session.orca-legacy-account-1.json')
    writeFileSync(occupiedPreservedPath, '{"turns":["kept"]}', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    mkdirSync(join(managedHomePath, 'sessions'), { recursive: true })
    writeFileSync(join(managedHomePath, 'sessions', 'session.json'), '{"turns":[1,2]}', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    await waitForHistorySettled()

    expect(readFileSync(occupiedPreservedPath, 'utf-8')).toBe('{"turns":["kept"]}')
    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1-1.json'), 'utf-8')
    ).toBe('{"turns":[1,2]}')
  })
})
