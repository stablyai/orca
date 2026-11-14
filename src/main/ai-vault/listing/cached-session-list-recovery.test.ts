import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultScanCoordinator } from '../scan-lifecycle/ai-vault-scan-coordinator'
import {
  nextScanObservationOrder,
  recordScanOutcome
} from '../scan-lifecycle/ai-vault-scan-recovery'
import { AiVaultScanStalledError } from '../scan-service/session-scanner-scan-inactivity'
const mocks = vi.hoisted(() => ({ scan: vi.fn(), roots: vi.fn() }))
vi.mock('../scan-service/session-scanner-background', () => ({
  scanAiVaultSessionsInBackground: mocks.scan,
  clearAiVaultBackgroundRestartCircuit: vi.fn(),
  resetAiVaultScannerBackgroundForTests: vi.fn()
}))
vi.mock('../discovery/ai-vault-scan-roots', () => ({
  resolveLocalAiVaultScanRoots: mocks.roots,
  resetAiVaultSessionSourcesForTests: vi.fn()
}))
import { listAiVaultSessions, resetAiVaultSessionListCacheForTests } from './cached-session-list'
const EMPTY = { sessions: [], issues: [], scannedAt: 'empty' }
const ROOTS = { roots: { additionalCodexSessionsDirs: [], wslHomeDirs: [] }, wslConfirmed: true }
afterEach(() => {
  resetAiVaultSessionListCacheForTests()
  vi.resetAllMocks()
  vi.useRealTimers()
})

it('shares one post-force local result across Local and All wrappers, even after local completion', async () => {
  mocks.roots.mockResolvedValue(ROOTS)
  const old = Promise.withResolvers<typeof EMPTY>()
  const entered = Promise.withResolvers<void>()
  mocks.scan.mockImplementationOnce(() => {
    entered.resolve()
    return old.promise
  })
  mocks.scan.mockResolvedValue({ ...EMPTY, scannedAt: 'fresh' })
  const runtime = listAiVaultSessions()
  await entered.promise
  const outer = new AiVaultScanCoordinator()
  const local = outer.run({
    key: 'Local',
    force: true,
    aggregate: true,
    start: (signal) => listAiVaultSessions({ force: true }, { signal })
  })
  const remote = Promise.withResolvers<typeof EMPTY>()
  const all = outer.run({
    key: 'All',
    force: true,
    aggregate: true,
    start: async (signal) => {
      const order = nextScanObservationOrder()
      const localResult = await listAiVaultSessions({ force: true }, { signal })
      await remote.promise
      recordScanOutcome(signal, 'remote', { ok: true, result: EMPTY, order })
      return localResult
    }
  })
  old.resolve(EMPTY)
  await expect(runtime).resolves.toMatchObject({ scannedAt: 'empty' })
  await expect(local).resolves.toMatchObject({ scannedAt: 'fresh' })
  remote.resolve(EMPTY)
  await expect(all).resolves.toMatchObject({ scannedAt: 'fresh' })
  expect(mocks.scan).toHaveBeenCalledTimes(2)
})

it('abandons a stalled root probe before child admission and fences its late completion', async () => {
  vi.useFakeTimers()
  const blocked = Promise.withResolvers<typeof ROOTS>()
  mocks.roots.mockImplementationOnce(() => blocked.promise).mockResolvedValue(ROOTS)
  mocks.scan.mockResolvedValue(EMPTY)
  const normal = listAiVaultSessions()
  await vi.advanceTimersByTimeAsync(0)
  const forced = listAiVaultSessions({ force: true })
  await vi.advanceTimersByTimeAsync(60000)
  await expect(Promise.all([normal, forced])).resolves.toHaveLength(2)
  expect(mocks.roots).toHaveBeenCalledTimes(2)
  expect(mocks.scan).toHaveBeenCalledOnce()
  blocked.resolve(ROOTS)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.scan).toHaveBeenCalledOnce()
  await listAiVaultSessions()
  expect(mocks.scan).toHaveBeenCalledOnce()
})

it('shares the probe and child retry budget, and preserves the terminal outcome for a trailing force', async () => {
  vi.useFakeTimers()
  mocks.roots.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(ROOTS)
  mocks.scan.mockRejectedValue(new AiVaultScanStalledError())
  const normal = listAiVaultSessions()
  const normalError = expect(normal).rejects.toThrow('stopped making progress')
  await vi.advanceTimersByTimeAsync(0)
  const forced = listAiVaultSessions({ force: true })
  const forcedError = expect(forced).rejects.toThrow('stopped making progress')
  await vi.advanceTimersByTimeAsync(60000)
  await Promise.all([normalError, forcedError])
  await vi.advanceTimersByTimeAsync(240000)
  expect(mocks.roots).toHaveBeenCalledTimes(2)
  expect(mocks.scan).toHaveBeenCalledOnce()
})
