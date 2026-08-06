import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'graph-owner-repo::/worktrees/feature'
const TAB_ID = 'graph-owner-tab'
const LEAF_ID = 'graph-owner-leaf'
const PTY_ID = 'graph-owner-pty'

function makeSnapshot(
  worktree = WORKTREE_ID,
  title = 'Initial',
  snapshotVersion = 1
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:graph-owner',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: `${TAB_ID}::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${TAB_ID}::${LEAF_ID}`,
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId: PTY_ID,
        title,
        isActive: true
      }
    ]
  }
}

function makeGraph(worktreeId: string, title: string) {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId,
        title,
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null
      }
    ],
    mobileSessionTabs: [structuredClone(makeSnapshot())]
  }
}

describe('mobile session graph owner normalization', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fans out a scoped graph alias change through the raw snapshot cache owner', () => {
    const runtime = new OrcaRuntimeService()
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.syncWindowGraph(1, makeGraph(WORKTREE_ID, 'Initial'))
    vi.advanceTimersByTime(300)
    events.length = 0

    runtime.syncWindowGraph(1, makeGraph(worktreeWorkspaceKey(WORKTREE_ID), 'Renamed'))
    vi.advanceTimersByTime(60)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      worktree: WORKTREE_ID,
      tabs: [{ type: 'terminal', title: 'Renamed' }]
    })
  })

  it('rejects colliding raw and scoped renderer snapshot owners', async () => {
    const runtime = new OrcaRuntimeService()

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        makeSnapshot(WORKTREE_ID, 'Raw', 1),
        makeSnapshot(worktreeWorkspaceKey(WORKTREE_ID), 'Scoped', 2)
      ]
    })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
  })

  it('stores PTY ownership under the normalized graph identity', () => {
    const runtime = new OrcaRuntimeService()
    runtime.registerPty(PTY_ID, worktreeWorkspaceKey(WORKTREE_ID))

    const pty = (
      runtime as unknown as { ptysById: Map<string, { worktreeId: string }> }
    ).ptysById.get(PTY_ID)

    expect(pty?.worktreeId).toBe(WORKTREE_ID)
  })

  it('notifies scoped owner changes through the normalized snapshot cache key', () => {
    const runtime = new OrcaRuntimeService()
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    runtime.syncWindowGraph(1, makeGraph(WORKTREE_ID, 'Initial'))
    vi.advanceTimersByTime(300)
    events.length = 0

    runtime.notifyMobileSessionTabsChanged(worktreeWorkspaceKey(WORKTREE_ID))

    expect(events).toHaveLength(1)
    expect(events[0]?.worktree).toBe(WORKTREE_ID)
  })
})
