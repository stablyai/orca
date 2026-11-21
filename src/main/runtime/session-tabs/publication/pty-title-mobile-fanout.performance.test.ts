import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const T0 = 1_700_000_000_000

// Perf contract (#44491, STA-16123): each PTY title change scanned every workspace's mobile session snapshot and
// tab, twice (republish and status heartbeat), so title churn cost grew with the fleet. Counts reads of other
// workspaces' tabs, which must stay 0 at N and 10N.

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

const WORKTREE_ID = 'wt-target'
const TAB_ID = 'tab-target'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-target'

function terminalSnapshot(
  worktree: string,
  ptyId: string,
  onTabRead?: () => void
): RuntimeMobileSessionTabsSnapshot {
  const tab: RuntimeMobileSessionTerminalTab = {
    type: 'terminal',
    id: `${TAB_ID}::${LEAF_ID}`,
    parentTabId: TAB_ID,
    leafId: LEAF_ID,
    ptyId,
    title: 'Terminal',
    isActive: true
  }
  if (onTabRead) {
    Object.defineProperty(tab, 'type', {
      enumerable: true,
      get: () => {
        onTabRead()
        return 'terminal'
      }
    })
  }
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tab.id,
    activeTabType: 'terminal',
    tabs: [tab]
  }
}

describe('PTY title fanout to mobile session snapshots', () => {
  it('touches only the PTY’s workspace and reads no other workspace’s tabs, at N and 10N workspaces', async () => {
    const runtime = new OrcaRuntimeService(null)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: WORKTREE_ID,
      path: '/repo/app',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    await runtime.createTerminal(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'Terminal'
    })
    runtime.mobileSessionTabsByWorktree.set(WORKTREE_ID, terminalSnapshot(WORKTREE_ID, PTY_ID))

    runtime.onMobileSessionTabsChanged(() => {})
    let fleetTabReads = 0
    let fleetSize = 0
    let title = 0
    for (const n of [200, 2_000]) {
      for (; fleetSize < n; fleetSize++) {
        const worktree = `wt-fleet-${fleetSize}`
        runtime.mobileSessionTabsByWorktree.set(
          worktree,
          terminalSnapshot(worktree, `pty-fleet-${fleetSize}`, () => fleetTabReads++)
        )
      }
      fleetTabReads = 0
      const before = runtime.mobileSessionTabsByWorktree.get(WORKTREE_ID)!.snapshotVersion
      const at = T0 + ++title * 1_000
      vi.setSystemTime(at)
      runtime.onPtyData(PTY_ID, `\x1b]0;Task ${title}\x07`, at)
      vi.advanceTimersByTime(1_000)

      expect({
        fleetTabReads,
        targetVersion: runtime.mobileSessionTabsByWorktree.get(WORKTREE_ID)!.snapshotVersion,
        fleetVersion: runtime.mobileSessionTabsByWorktree.get('wt-fleet-0')!.snapshotVersion
      }).toEqual({ fleetTabReads: 0, targetVersion: before + 1, fleetVersion: 1 })
    }
  })
})
