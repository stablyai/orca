import { afterEach, expect, it, vi } from 'vitest'
import { scanLocalAiVaultSessionsAsIssue } from '../../ipc/ai-vault/ai-vault-local-list'
import type { AiVaultRowDelta, AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'
import { listResult } from '../structured-sessions/structured-session-ownership.test-support'
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

it('invalidates an older scope cache when a recovered ordinary result satisfies an outer force', async () => {
  vi.useFakeTimers()
  const project = { scopePaths: ['/repo'], scopeOnly: true }
  mocks.roots.mockResolvedValue(ROOTS)
  mocks.scan.mockResolvedValueOnce({ ...EMPTY, scannedAt: 'stale-scope' })
  await listAiVaultSessions(project)
  const blocked = Promise.withResolvers<typeof EMPTY>()
  const entered = Promise.withResolvers<void>()
  const fresh = { ...EMPTY, scannedAt: 'recovered' }
  mocks.scan
    .mockImplementationOnce(() => {
      entered.resolve()
      return blocked.promise
    })
    .mockResolvedValue(fresh)
  const outer = new AiVaultScanCoordinator()
  const start = vi.fn((signal: AbortSignal) =>
    listAiVaultSessions({ scopePaths: ['/repo'] }, { signal })
  )
  const ordinary = outer.run({ key: 'All', aggregate: true, start })
  await entered.promise
  const forced = outer.run({ key: 'All', force: true, aggregate: true, start })
  blocked.reject(new AiVaultScanStalledError())
  await expect(Promise.all([ordinary, forced])).resolves.toHaveLength(2)
  expect(start).toHaveBeenCalledOnce()
  await expect(listAiVaultSessions(project)).resolves.toMatchObject({ scannedAt: 'recovered' })
  expect(mocks.scan).toHaveBeenCalledTimes(3)
})

it('replays retained local rows on nested observer activation without resurrecting removals', async () => {
  mocks.roots.mockResolvedValue(ROOTS)
  const pending = Promise.withResolvers<typeof EMPTY>()
  const entered = Promise.withResolvers<void>()
  let publish!: (delta: AiVaultRowDelta) => void
  mocks.scan.mockImplementation((_args, _signal, _progress, emit) => {
    publish = emit
    entered.resolve()
    return pending.promise
  })
  const outer = new AiVaultScanCoordinator()
  const start = (signal: AbortSignal, _id: string, emit: (delta: AiVaultRowDelta) => void) =>
    scanLocalAiVaultSessionsAsIssue(undefined, signal, emit)
  const all = outer.run({ key: 'All', start, observeRows: () => undefined })
  await entered.promise
  const local = outer.run({ key: 'Local', start })
  await Promise.resolve()
  const firstRow = { ...listResult().sessions[0]!, id: 'first-row' }
  const nextRow = { ...listResult().sessions[0]!, id: 'next-row' }
  publish({ upserts: [firstRow], removed: [] })
  const rows = new Map<string, typeof firstRow>()
  const observe = vi.fn((event: AiVaultScanRows) => {
    if (event.kind === 'snapshot') {
      rows.clear()
      for (const row of event.sessions) {
        rows.set(row.id, row)
      }
    } else {
      for (const id of event.delta.removed) {
        rows.delete(id)
      }
      for (const row of event.delta.upserts) {
        rows.set(row.id, row)
      }
    }
  })
  const controller = new AbortController()
  const stream = outer.run({ key: 'Local', start, observeRows: observe, signal: controller.signal })
  expect([...rows.keys()]).toEqual([firstRow.id])
  controller.abort()
  await expect(stream).rejects.toMatchObject({ name: 'AbortError' })
  publish({ upserts: [nextRow], removed: [firstRow.id] })
  const resumed = outer.run({ key: 'Local', start, observeRows: observe })
  const shared = outer.run({ key: 'Local', start, observeRows: observe })
  expect([...rows.keys()]).toEqual([nextRow.id])
  const calls = observe.mock.calls.length
  publish({ upserts: [], removed: [nextRow.id] })
  expect(observe).toHaveBeenCalledTimes(calls + 1)
  expect(rows.size).toBe(0)
  pending.resolve(EMPTY)
  await Promise.all([all, local, resumed, shared])
})

it('keeps a newer accepted cache when an older forced scan finishes later', async () => {
  mocks.roots.mockResolvedValue(ROOTS)
  const older = Promise.withResolvers<typeof EMPTY>()
  const oldEntered = Promise.withResolvers<void>()
  mocks.scan.mockImplementationOnce(() => {
    oldEntered.resolve()
    return older.promise
  })
  const first = listAiVaultSessions({ scopePaths: ['/old'], force: true })
  await oldEntered.promise
  mocks.scan.mockResolvedValueOnce({ ...EMPTY, scannedAt: 'newer' })
  await listAiVaultSessions({ scopePaths: ['/new'], force: true })
  older.resolve({ ...EMPTY, scannedAt: 'older' })
  await first
  await expect(listAiVaultSessions({ scopePaths: ['/new'] })).resolves.toMatchObject({
    scannedAt: 'newer'
  })
  expect(mocks.scan).toHaveBeenCalledTimes(2)
})

it('does not invalidate sibling cache policy after the sole force detaches', async () => {
  mocks.roots.mockResolvedValue(ROOTS)
  const project = { scopePaths: ['/repo'], scopeOnly: true }
  mocks.scan.mockResolvedValueOnce({ ...EMPTY, scannedAt: 'scope-cache' })
  await listAiVaultSessions(project)
  const pending = Promise.withResolvers<typeof EMPTY>()
  const entered = Promise.withResolvers<void>()
  mocks.scan.mockImplementationOnce(() => {
    entered.resolve()
    return pending.promise
  })
  const controller = new AbortController()
  const forced = listAiVaultSessions(
    { scopePaths: ['/repo'], force: true },
    { signal: controller.signal }
  )
  await entered.promise
  const ordinary = listAiVaultSessions({ scopePaths: ['/repo'] })
  controller.abort()
  await expect(forced).rejects.toMatchObject({ name: 'AbortError' })
  pending.resolve({ ...EMPTY, scannedAt: 'ordinary' })
  await ordinary
  await expect(listAiVaultSessions(project)).resolves.toMatchObject({ scannedAt: 'scope-cache' })
  expect(mocks.scan).toHaveBeenCalledTimes(2)
})
