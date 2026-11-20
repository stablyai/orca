import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
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

    expect(readFileSync(runtimeHistoryPath, 'utf-8')).toBe(
      '{"id":"shared-1"}\n{"id":"managed-2"}\n'
    )
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'migration-v1.json'))).toBe(
      true
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
})
