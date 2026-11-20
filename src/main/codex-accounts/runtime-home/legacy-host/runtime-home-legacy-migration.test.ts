import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  appendFileSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
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
    .map(([, props]) => (props as { outcome: string }).outcome)
}

async function waitForHistoryImport(): Promise<void> {
  await vi.waitFor(() => expect(trackedImportOutcomes()).toContain('imported'), {
    timeout: 15_000
  })
  trackMock.mockClear()
}

// Holds a lock the way Codex does: flock(2) on the file, until released.
async function holdWithFlock(lockPath: string): Promise<() => Promise<void>> {
  writeFileSync(lockPath, '')
  const holder = spawn('perl', [
    '-e',
    'use Fcntl qw(:flock); open(my $l, "+<", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "locked\\n"; <STDIN>',
    lockPath
  ])
  const closed = new Promise((resolve) => holder.once('close', resolve))
  await createInterface({ input: holder.stdout })[Symbol.asyncIterator]().next()
  return async () => {
    holder.stdin.end()
    await closed
  }
}

const fsHooks = vi.hoisted(() => ({ afterRead: new Map<string, () => void>() }))
vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const contents = actual.readFileSync(...args)
    fsHooks.afterRead.get(String(args[0]))?.()
    return contents
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
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

    expect(normalizeLinkTarget(readlinkSync(legacyActiveHomePath))).toBe(
      normalizeLinkTarget(getRuntimeCodexHomePath())
    )
    expect(readFileSync(join(legacyActiveHomePath, 'auth.json'), 'utf-8')).toBe(
      '{"account":"system"}\n'
    )
  })

  it('imports legacy managed-home history into the shared runtime history', async () => {
    const runtimeHomePath = getRuntimeCodexHomePath()
    const runtimeHistoryPath = join(runtimeHomePath, 'history.jsonl')
    writeFileSync(runtimeHistoryPath, '{"id":"shared-1"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    writeFileSync(
      join(managedHomePath, 'history.jsonl'),
      '{"id":"shared-1"}\n{"id":"managed-2"}\n',
      'utf-8'
    )
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    await waitForHistoryImport()
    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe(
      '{"id":"shared-1"}\n{"id":"managed-2"}\n'
    )
  })

  it('does not re-run migration when marker already exists', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    writeFileSync(join(managedHomePath, 'history.jsonl'), '{"id":"legacy-1"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    await waitForHistoryImport()
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toContain('legacy-1')

    writeFileSync(
      join(managedHomePath, 'history.jsonl'),
      '{"id":"legacy-1"}\n{"id":"legacy-2"}\n',
      'utf-8'
    )

    vi.resetModules()
    const mod2 = await import('../../runtime-home-service')
    new mod2.CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).not.toContain('legacy-2')
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

  it('keeps history lines Codex appends while legacy history is merged', async () => {
    const runtimeHistoryPath = join(getRuntimeCodexHomePath(), 'history.jsonl')
    writeFileSync(runtimeHistoryPath, '{"id":"shared-1"}\n', 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const legacyHistoryPath = join(managedHomePath, 'history.jsonl')
    writeFileSync(legacyHistoryPath, '{"id":"managed-2"}\n', 'utf-8')
    fsHooks.afterRead.set(legacyHistoryPath, () =>
      appendFileSync(runtimeHistoryPath, '{"id":"codex-live"}\n', 'utf-8')
    )
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    await waitForHistoryImport()
    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe(
      '{"id":"shared-1"}\n{"id":"codex-live"}\n{"id":"managed-2"}\n'
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
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(occupiedPreservedPath, 'utf-8')).toBe('{"turns":["kept"]}')
    expect(
      readFileSync(join(runtimeSessionsDir, 'session.orca-legacy-account-1-1.json'), 'utf-8')
    ).toBe('{"turns":[1,2]}')
  })

  it.skipIf(process.platform === 'win32')(
    'leaves legacy history pending while a Codex thread is live, then imports it',
    async () => {
      const runtimeHomePath = getRuntimeCodexHomePath()
      const runtimeHistoryPath = join(runtimeHomePath, 'history.jsonl')
      writeFileSync(runtimeHistoryPath, '{"id":"shared-1"}\n', 'utf-8')
      const managedHomePath = createManagedAuth(
        testState.userDataDir,
        'account-1',
        '{"account":"managed"}\n'
      )
      writeFileSync(join(managedHomePath, 'history.jsonl'), '{"id":"managed-2"}\n', 'utf-8')
      const locks = join(runtimeHomePath, 'thread-writer-locks')
      mkdirSync(locks, { recursive: true })
      const releaseThread = await holdWithFlock(
        join(locks, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.lock')
      )
      const store = createStore(createSettings())
      const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
      try {
        new CodexRuntimeHomeService(store as never)
        await vi.waitFor(() => expect(trackedImportOutcomes()).toEqual(['codex_live']), {
          timeout: 15_000
        })
        expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe('{"id":"shared-1"}\n')
      } finally {
        await releaseThread()
      }

      vi.resetModules()
      const relaunched = await import('../../runtime-home-service')
      new relaunched.CodexRuntimeHomeService(store as never)

      await waitForHistoryImport()
      expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe(
        '{"id":"shared-1"}\n{"id":"managed-2"}\n'
      )
    }
  )
})
