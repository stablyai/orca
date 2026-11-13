import { expect, it, vi } from 'vitest'
import { createReconciliationDeliveryRuntime } from './client-page-reconciliation-delivery-test-harness'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

it.each([750, 7500])(
  'only clears previously held frames in a %i-workspace runtime',
  async (count) => {
    const h = createReconciliationDeliveryRuntime()
    const runtime = h.hostRuntime
    const snapshots = Array.from({ length: count }, (_, index) => ({
      worktree: `repo-1::/tmp/worktree-${index}`,
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }))
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots })
    await runtime.markClientHostedPagesReconciled('device-a')
    const frames: RuntimeMobileSessionTabsResult[] = []
    const otherFrames: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged(
      (frame) => frames.push(frame),
      'device-a',
      'mobile'
    )
    const unsubscribeHeld = runtime.onMobileSessionTabsChanged(
      (frame) => otherFrames.push(frame),
      'device-b',
      'mobile'
    )
    const facts = runtime.sidebarFacts
    if (!facts) {
      throw new Error('sidebar facts fixture is required')
    }
    const refresh = vi.spyOn(facts.workspaceActivityFacts, 'refreshWorkspace')
    try {
      runtime.projectedFrames = 0
      const attached = h.attach()
      expect(runtime.projectedFrames).toBe(0)
      expect(frames).toEqual([])
      expect(otherFrames).toEqual([])
      expect(refresh).not.toHaveBeenCalled()
      attached.abort()
      await attached.completion
      const heldWorktrees = [snapshots[0]!.worktree, snapshots[count - 1]!.worktree]
      for (const worktree of heldWorktrees) {
        expect(
          (await runtime.snapshotForClient(worktree, 'device-b')).clientHostedPagesUnreconciled
        ).toBe(true)
      }
      runtime.projectedFrames = 0
      await runtime.markClientHostedPagesReconciled('device-b')
      expect(runtime.projectedFrames).toBe(2)
      expect(otherFrames.map((frame) => frame.worktree)).toEqual(heldWorktrees)
      expect(otherFrames.every((frame) => frame.clientHostedPagesUnreconciled === undefined)).toBe(
        true
      )
      expect(frames).toEqual([])
      expect(refresh).not.toHaveBeenCalled()
      otherFrames.length = 0
      runtime.projectedFrames = 0
      await runtime.markClientHostedPagesReconciled('device-b')
      expect(runtime.projectedFrames).toBe(0)
      expect(otherFrames).toEqual([])
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      refresh.mockRestore()
      unsubscribe()
      unsubscribeHeld()
      await h.close()
    }
  }
)

it('does not owe delivery for speculative projections and forgets removed workspaces', async () => {
  const h = createReconciliationDeliveryRuntime()
  const runtime = h.hostRuntime
  const worktree = 'repo-1::/tmp/worktree-observed'
  const frames: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged(
    (frame) => frames.push(frame),
    'device-a',
    'mobile'
  )
  const unsubscribeOther = runtime.onMobileSessionTabsChanged(
    (frame) => frames.push(frame),
    'device-b',
    'mobile'
  )
  try {
    expect(
      (await runtime.peekSnapshotForClient(worktree, 'device-a')).clientHostedPagesUnreconciled
    ).toBe(true)
    await runtime.markClientHostedPagesReconciled('device-a')
    expect(frames).toEqual([])
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree,
          publicationEpoch: 'renderer',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    expect(
      (await runtime.snapshotForClient(worktree, 'device-b')).clientHostedPagesUnreconciled
    ).toBe(true)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    frames.length = 0
    await runtime.markClientHostedPagesReconciled('device-b')
    expect(frames).toEqual([])
  } finally {
    unsubscribe()
    unsubscribeOther()
    await h.close()
  }
})

it('keeps each subscription last held frame independently of later read replies', async () => {
  const h = createReconciliationDeliveryRuntime()
  const runtime = h.hostRuntime
  const worktree = 'repo-1::/tmp/worktree-observed'
  const frames: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged(
    (frame) => frames.push(frame),
    'device-a',
    'mobile'
  )
  try {
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree,
          publicationEpoch: 'renderer',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    // A subscription flush is a production delivery boundary.
    runtime.onMobileSessionTabsChanged(() => {}, 'other-device', 'mobile')()
    expect(frames.some((frame) => frame.clientHostedPagesUnreconciled === true)).toBe(true)
    frames.length = 0
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 45_001)
    expect(
      (await runtime.snapshotForClient(worktree, 'device-a')).clientHostedPagesUnreconciled
    ).toBeUndefined()
    await runtime.markClientHostedPagesReconciled('device-a')
    expect(frames.map((frame) => [frame.worktree, frame.clientHostedPagesUnreconciled])).toEqual([
      [worktree, undefined]
    ])
    frames.length = 0
    await runtime.markClientHostedPagesReconciled('device-a')
    expect(frames).toEqual([])
  } finally {
    vi.restoreAllMocks()
    unsubscribe()
    await h.close()
  }
})
