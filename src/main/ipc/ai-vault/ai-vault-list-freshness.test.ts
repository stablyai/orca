import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ scan: vi.fn(), runtime: vi.fn() }))
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../../ai-vault/scan-service/session-scanner-background', () => ({
  scanAiVaultSessionsInBackground: mocks.scan,
  clearAiVaultBackgroundRestartCircuit: vi.fn(),
  resetAiVaultScannerBackgroundForTests: vi.fn()
}))
vi.mock('../../ai-vault/discovery/ai-vault-scan-roots', () => ({
  configureAiVaultSessionSources: vi.fn(),
  resetAiVaultSessionSourcesForTests: vi.fn(),
  resolveLocalAiVaultScanRoots: vi.fn(async () => ({
    roots: { additionalCodexSessionsDirs: [], wslHomeDirs: [] },
    wslConfirmed: true
  }))
}))
vi.mock('../../ai-vault/runtime-hosts/ai-vault-runtime-scan', () => ({
  scanRuntimeAiVaultSessions: mocks.runtime
}))
import { _internals, registerAiVaultHandlers } from './ai-vault'
import { listAiVaultSessions as localList } from '../../ai-vault/listing/cached-session-list'
import { listResult } from '../../ai-vault/structured-sessions/structured-session-ownership.test-support'
const empty = { sessions: [], issues: [], scannedAt: 'empty' }
afterEach(() => {
  _internals.resetAiVaultCacheForTests()
  vi.resetAllMocks()
  vi.useRealTimers()
})

it.each(['local', 'all'] as const)(
  'honors a force absorbed before an ordinary %s cohort starts, bypassing both caches',
  async (scope) => {
    registerAiVaultHandlers()
    mocks.scan.mockResolvedValue(empty)
    mocks.runtime.mockResolvedValue(empty)
    const args = { executionHostScope: scope }
    await _internals.listAiVaultSessions(args)
    const changed = { ...listResult(), scannedAt: 'fresh' }
    mocks.scan.mockResolvedValue(changed)
    await expect(_internals.listAiVaultSessions(args)).resolves.toMatchObject({
      scannedAt: expect.any(String)
    })
    expect(mocks.scan).toHaveBeenCalledOnce()
    const ordinary = _internals.listAiVaultSessions(args)
    const forced = _internals.listAiVaultSessions({ ...args, force: true })
    const [, result] = await Promise.all([ordinary, forced])
    expect(result.sessions.map((row) => row.id)).toEqual(changed.sessions.map((row) => row.id))
    expect(mocks.scan).toHaveBeenCalledTimes(2)
  }
)

it('disarms nested recovery after the last force detaches while an ordinary owner remains', async () => {
  vi.useFakeTimers()
  registerAiVaultHandlers()
  let signal!: AbortSignal
  const pending = Promise.withResolvers<typeof empty>()
  mocks.scan.mockImplementation((_options, attempt: AbortSignal) => {
    signal = attempt
    return pending.promise
  })
  const controller = new AbortController()
  const forced = _internals.listAiVaultSessions({ force: true }, { signal: controller.signal })
  const cancelled = expect(forced).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  const ordinary = _internals.listAiVaultSessions()
  controller.abort()
  await cancelled
  const { SessionScanInactivity } =
    await import('../../ai-vault/scan-service/session-scanner-scan-inactivity')
  const stalled = vi.fn()
  const inactivity = new SessionScanInactivity(signal, stalled)
  inactivity.activity(0)
  await vi.advanceTimersByTimeAsync(120000)
  expect(signal.aborted).toBe(false)
  expect(stalled).not.toHaveBeenCalled()
  pending.resolve(empty)
  await ordinary
  inactivity.dispose()
})

it('refreshes an old remote leg while reusing recovered local completion and its terminal issue', async () => {
  vi.useFakeTimers()
  const { AiVaultScanStalledError } =
    await import('../../ai-vault/scan-service/session-scanner-scan-inactivity')
  registerAiVaultHandlers({
    getActiveRuntimeAiVaultHostInfos: () => [
      { environmentId: 'peer', executionHostId: 'runtime:peer' }
    ]
  })
  const entered = Promise.withResolvers<void>()
  const stalled = Promise.withResolvers<typeof empty>()
  mocks.scan
    .mockImplementationOnce(() => {
      entered.resolve()
      return stalled.promise
    })
    .mockRejectedValue(new AiVaultScanStalledError())
  mocks.runtime.mockResolvedValue(empty)
  const runtime = localList()
  const runtimeError = expect(runtime).rejects.toThrow('stopped making progress')
  await entered.promise
  const all = _internals.listAiVaultSessions({ executionHostScope: 'all' })
  await vi.advanceTimersByTimeAsync(0)
  const forced = _internals.listAiVaultSessions({ executionHostScope: 'all', force: true })
  stalled.reject(new AiVaultScanStalledError())
  await runtimeError
  const results = await Promise.all([all, forced])
  expect(results.every((result) => result.issues.length > 0)).toBe(true)
  expect(mocks.scan).toHaveBeenCalledTimes(2)
  expect(mocks.runtime).toHaveBeenCalledTimes(2)
})
