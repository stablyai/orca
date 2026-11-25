import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  existsSync,
  mkdirSync,
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
  getRuntimeCodexHomePath,
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

  // File symlinks need Developer Mode or elevation on Windows.
  it.skipIf(process.platform === 'win32')(
    'imports a linked account history and ignores an account folder without a home folder',
    async () => {
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
    }
  )

  it('never writes an existing shared history, and account removal keeps the account history', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    writeFileSync(runtimeHistoryPath, '{"id":"shared-1"}', 'utf-8')
    const managedHomePath = writeHistory('account-1', '{"id":"legacy-1"}\n')

    await constructService()
    // Startup itself must not rewrite it, before the import settles.
    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"shared-1"}')
    await waitForHistorySettled()
    await removeAccountHome(managedHomePath)

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"shared-1"}')
    expect(trackedImportOutcomes()).toEqual(['skipped_existing'])
    expect(readFileSync(join(managedHomePath, 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"legacy-1"}\n'
    )
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

    // Session copies finish during construction; check them before the history import settles.
    await constructService()

    expect(readFileSync(occupiedPreservedPath, 'utf-8')).toBe('{"turns":["kept"]}')
    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1-1.json'), 'utf-8')
    ).toBe('{"turns":[1,2]}')
    await waitForHistorySettled()
  })
})
