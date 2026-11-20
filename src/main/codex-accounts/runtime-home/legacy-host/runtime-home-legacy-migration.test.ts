import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  existsSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import type { CodexManagedHomePath } from '../../managed-homes/codex-managed-home-path'
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

function archivedHistoryPath(accountId: string): string {
  return join(
    testState.userDataDir,
    'codex-runtime-home',
    'legacy-account-history',
    accountId,
    'history.jsonl'
  )
}

async function constructService(): Promise<void> {
  const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements what the service reads.
  new CodexRuntimeHomeService(createStore(createSettings()) as never)
}

async function startService(): Promise<void> {
  await constructService()
  await waitForMigrationMarker()
}

// Settled: the marker exists and no longer waits on the history import.
async function waitForMigrationMarker(): Promise<void> {
  const markerPath = join(testState.userDataDir, 'codex-runtime-home', 'migration-v1.json')
  await vi.waitFor(() => {
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, 'utf-8')).not.toContain('"historyImportPending"')
  })
}

async function removeAccountHome(managedHomePath: string): Promise<void> {
  const { CodexManagedHomeLifecycle } =
    await import('../../managed-homes/codex-managed-home-lifecycle')
  const paths = {
    assert: async (candidate: string) => candidate,
    getRoot: () => join(testState.userDataDir, 'codex-accounts')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: safeRemove reads only these two members.
  } as unknown as CodexManagedHomePath
  await new CodexManagedHomeLifecycle(paths).safeRemove(managedHomePath, 'account-1')
}

const fsHooks = vi.hoisted(() => ({ afterRead: new Map<string, () => void>() }))
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every overload unchanged.
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const contents = await actual.readFile(...args)
    fsHooks.afterRead.get(String(args[0]))?.()
    return contents
  }) as typeof actual.readFile
  return { ...actual, default: { ...actual, readFile }, readFile }
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
    await waitForMigrationMarker()

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

  it('keeps every legacy history aside before startup returns, even when a session copy fails', async () => {
    const accountOneHome = writeHistory('account-1', '{"id":"a-1"}\n')
    const accountTwoHome = writeHistory('account-2', '{"id":"b-1"}\n')
    mkdirSync(join(accountTwoHome, 'sessions', 'nested'), { recursive: true })
    writeFileSync(join(accountTwoHome, 'sessions', 'nested', 'rollout.jsonl'), '{}', 'utf-8')
    mkdirSync(join(getRuntimeCodexHomePath(), 'sessions'), { recursive: true })
    // A file where account 2's session folder must go: its session copy throws.
    writeFileSync(join(getRuntimeCodexHomePath(), 'sessions', 'nested'), 'not a folder', 'utf-8')
    await constructService()
    await removeAccountHome(accountOneHome)

    expect(existsSync(join(accountOneHome, 'history.jsonl'))).toBe(false)
    expect(readFileSync(archivedHistoryPath('account-1'), 'utf-8')).toBe('{"id":"a-1"}\n')
    expect(readFileSync(archivedHistoryPath('account-2'), 'utf-8')).toBe('{"id":"b-1"}\n')
  })

  it('never writes an existing shared history and keeps the legacy one aside, even past account removal', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    writeFileSync(runtimeHistoryPath, '{"id":"shared-1"}', 'utf-8')
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')

    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"shared-1"}')
    expect(trackedImportOutcomes()).toEqual(['skipped_existing'])
    expect(readFileSync(join(managedHomePath, 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"legacy-1"}\n'
    )

    await removeAccountHome(managedHomePath)

    expect(existsSync(join(managedHomePath, 'history.jsonl'))).toBe(false)
    expect(readFileSync(archivedHistoryPath('account-1'), 'utf-8')).toBe('{"id":"legacy-1"}\n')
  })

  it('leaves a shared history Codex creates during the import as it is', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    writeHistory('account-1', '{"id":"legacy-1"}\n')
    fsHooks.afterRead.set(archivedHistoryPath('account-1'), () =>
      writeFileSync(runtimeHistoryPath, '{"id":"codex-new"}\n', 'utf-8')
    )

    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"codex-new"}\n')
    expect(trackedImportOutcomes()).toEqual(['skipped_existing'])
    expect(readFileSync(archivedHistoryPath('account-1'), 'utf-8')).toBe('{"id":"legacy-1"}\n')
  })

  it('retries a failed import on a later launch from the kept copy, after the account is gone', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')
    fsHooks.afterRead.set(archivedHistoryPath('account-1'), () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    await constructService()
    await vi.waitFor(() => expect(trackedImportOutcomes()).toEqual(['failed']))
    expect(existsSync(runtimeHistoryPath)).toBe(false)
    await removeAccountHome(managedHomePath)
    fsHooks.afterRead.clear()

    vi.resetModules()
    await startService()

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"legacy-1"}\n')
    expect(trackedImportOutcomes()).toEqual(['failed', 'imported'])
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
    await waitForMigrationMarker()

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
    await waitForMigrationMarker()

    expect(readFileSync(occupiedPreservedPath, 'utf-8')).toBe('{"turns":["kept"]}')
    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1-1.json'), 'utf-8')
    ).toBe('{"turns":[1,2]}')
  })
})
