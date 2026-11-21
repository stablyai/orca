import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Perf contract: every agent-status row change re-stored its workspace's session-tabs snapshot (a walk of
// every tab), even with no client listening, so main allocation grew with chats x status updates.
// N status changes in one flush window must store once per workspace, and never with no listener.

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

const WORKTREES = ['wt-a', 'wt-b']

function snapshot(worktree: string): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function burst(runtime: OrcaRuntimeService, n: number): void {
  for (let i = 0; i < n; i++) {
    for (const worktree of WORKTREES) {
      runtime.touchMobileSessionTabsForWorktree(worktree)
    }
  }
  vi.advanceTimersByTime(1_000)
}

describe('status-driven session-tabs republish', () => {
  it('stores once per workspace per flush window with a listener, and never without one', () => {
    const runtime = new OrcaRuntimeService(null)
    for (const worktree of WORKTREES) {
      runtime.mobileSessionTabsByWorktree.set(worktree, snapshot(worktree))
    }
    const store = vi.spyOn(runtime, 'storeMobileSessionSnapshot')

    for (const n of [20, 200]) {
      store.mockClear()
      burst(runtime, n)
      expect(store).toHaveBeenCalledTimes(0)
    }

    const unsubscribe = runtime.onMobileSessionTabsChanged(() => {})
    for (const n of [20, 200]) {
      store.mockClear()
      const before = runtime.mobileSessionTabsByWorktree.get('wt-a')!.snapshotVersion
      burst(runtime, n)
      expect(store).toHaveBeenCalledTimes(WORKTREES.length)
      expect(runtime.mobileSessionTabsByWorktree.get('wt-a')!.snapshotVersion).toBe(before + 1)
    }
    unsubscribe()
  })
})
