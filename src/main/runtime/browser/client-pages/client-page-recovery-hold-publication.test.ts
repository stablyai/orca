import { expect, it, vi } from 'vitest'
import { createReconciliationDeliveryRuntime } from './client-page-reconciliation-delivery-test-harness'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

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
