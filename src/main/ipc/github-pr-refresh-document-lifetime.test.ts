import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'

const { handlers, lookup, contents } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  lookup: vi.fn(),
  contents: new Map<number, EventEmitter & { id: number; isDestroyed: () => boolean }>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  webContents: { fromId: (id: number) => contents.get(id) }
}))
vi.mock('../github/client', () => ({ getPRForBranch: vi.fn(), getPRForBranchOutcome: lookup }))
vi.mock('../github/pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: async () => null
}))
vi.mock('../wsl/wsl-unc-access-gate', () => ({
  wslDistroForPath: () => null,
  blockedWslDistroForPath: async () => null
}))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCoalescedCrashBreadcrumb: () => {}
}))
vi.mock('./ui', () => ({ sendToTrustedUIRenderer: () => {} }))
vi.mock('./github-repo-routing', () => ({
  validateAutomaticPRRefreshCandidate: (candidate: unknown) => ({ kind: 'ok', candidate }),
  isPRRefreshCandidateRegistered: () => true
}))

import { makeCandidate, makePR } from '../github/pr-refresh-coordinator-test-harness'

function sender(id: number) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false })
}
function found(): PRRefreshOutcome {
  return { kind: 'found', pr: makePR({ checksStatus: 'pending' }), fetchedAt: Date.now() }
}
async function setup() {
  const { registerGitHubPRRefreshHandlers } = await import('./github-pr-refresh-handlers')
  const coordinator = await import('../github/pr-refresh-coordinator')
  const owner = sender(17)
  const other = sender(18)
  contents.set(owner.id, owner)
  contents.set(other.id, other)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Visible refresh registration reads only this store fixture's repo list.
  const store = { getRepos: () => [] } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every PR is already counted, so the observer reads only this stats method.
  const stats = { hasCountedPR: () => true } as never
  registerGitHubPRRefreshHandlers(store, stats)
  const report = (target = owner) =>
    handlers.get('gh:reportVisiblePRRefreshCandidates')!(
      { sender: target },
      { candidates: [makeCandidate()], generation: Date.now() }
    )
  return { owner, other, report, coordinator }
}

describe('automatic PR refresh document ownership', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    handlers.clear()
    contents.clear()
    lookup.mockReset().mockImplementation(async () => found())
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
    'stops automatic lookups and admits replacement reports after %s',
    async (event) => {
      const { owner, report, coordinator } = await setup()
      report()
      await vi.advanceTimersByTimeAsync(0)
      expect(lookup).toHaveBeenCalledTimes(1)
      owner.emit(event)
      expect(coordinator._getVisiblePRRefreshWindowCountForTests()).toBe(0)
      expect(coordinator._getPRRefreshQueueSizeForTests()).toBe(0)
      await vi.advanceTimersByTimeAsync(360_000)
      expect(lookup).toHaveBeenCalledTimes(1)
      report()
      await vi.advanceTimersByTimeAsync(0)
      expect(lookup).toHaveBeenCalledTimes(2)
      owner.emit('destroyed')
    }
  )

  it('keeps a surviving window subscription and same-document navigation live', async () => {
    const { owner, other, report, coordinator } = await setup()
    report()
    report(other)
    await vi.advanceTimersByTimeAsync(0)
    expect(lookup).toHaveBeenCalledTimes(1)
    owner.emit('did-navigate-in-page', {}, '#section', true)
    expect(coordinator._getVisiblePRRefreshWindowCountForTests()).toBe(2)
    owner.emit('render-process-gone')
    expect(coordinator._getVisiblePRRefreshWindowCountForTests()).toBe(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(lookup).toHaveBeenCalledTimes(2)
    other.emit('destroyed')
    await vi.advanceTimersByTimeAsync(360_000)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('does not requeue a late lookup after document retirement', async () => {
    const pending = Promise.withResolvers<PRRefreshOutcome>()
    lookup.mockImplementationOnce(() => pending.promise)
    const { owner, report, coordinator } = await setup()
    report()
    await vi.advanceTimersByTimeAsync(0)
    owner.emit('render-process-gone')
    pending.resolve(found())
    await vi.advanceTimersByTimeAsync(360_000)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(coordinator._getVisiblePRRefreshWindowCountForTests()).toBe(0)
    expect(coordinator._getPRRefreshQueueSizeForTests()).toBe(0)
  })

  it('bounds native listeners over ten document replacements', async () => {
    const { owner, report } = await setup()
    for (let index = 0; index < 10; index += 1) {
      report()
      expect(owner.listenerCount('did-navigate')).toBe(1)
      expect(owner.listenerCount('render-process-gone')).toBe(1)
      expect(owner.listenerCount('destroyed')).toBe(1)
      owner.emit(index % 2 === 0 ? 'did-navigate' : 'render-process-gone')
      expect(owner.eventNames()).toEqual([])
    }
  })
})
