import { RpcDispatcher } from '../../rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../rpc/methods/session-tabs/session-tabs'
import { expect, it, vi } from 'vitest'
import { createReconciliationDeliveryRuntime } from './client-page-reconciliation-delivery-test-harness'
import { openRecoveryTabsStream } from './client-page-recovery-stream-test-harness'

const WORKSPACE = 'repo-1::/tmp/worktree-a'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

it.each([750, 7500])(
  'owes no completion for %i workspace updates filtered by a real RPC stream',
  async (count) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = createReconciliationDeliveryRuntime()
    const runtime = h.hostRuntime
    const snapshots = [
      WORKSPACE,
      ...Array.from({ length: count }, (_, index) => `repo-1::/tmp/filtered-${index}`)
    ].map((worktree) => ({
      worktree,
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots })
    const stream = openRecoveryTabsStream(runtime, 'filtered-stream', `id:${WORKSPACE}`)
    const facts = runtime.sidebarFacts!
    const refresh = vi.spyOn(facts.workspaceActivityFacts, 'refreshWorkspace')
    try {
      await stream.initial
      for (const snapshot of snapshots.slice(1)) {
        runtime.notifyMobileSessionTabsChanged(snapshot.worktree)
      }
      runtime.onMobileSessionTabsChanged(() => {}, 'flush-device', 'mobile')()
      expect(stream.frames.every((frame) => frame.worktree === WORKSPACE)).toBe(true)
      vi.setSystemTime(Date.now() + 46_000)
      runtime.notifyMobileSessionTabsChanged(WORKSPACE)
      runtime.onMobileSessionTabsChanged(() => {}, 'flush-device', 'mobile')()
      expect(stream.frames.at(-1)?.clientHostedPagesUnreconciled).toBeUndefined()
      runtime.projectedFrames = 0
      refresh.mockClear()
      const sequence = runtime.sessionTabsSequence()
      const delivered = stream.frames.length
      runtime.markClientHostedPagesReconciled('device-a')
      expect(runtime.projectedFrames).toBe(0)
      expect(runtime.sessionTabsSequence()).toBe(sequence)
      expect(stream.frames).toHaveLength(delivered)
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      stream.stop()
      await h.close()
      refresh.mockRestore()
      vi.useRealTimers()
    }
  }
)

it('keeps an independent held read after stream progression, then forgets disposed streams and removed workspaces', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const h = createReconciliationDeliveryRuntime()
  const runtime = h.hostRuntime
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WORKSPACE,
        publicationEpoch: 'renderer',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ]
  })
  const stream = openRecoveryTabsStream(runtime, 'progressing-stream', `id:${WORKSPACE}`)
  const independent = openRecoveryTabsStream(runtime, 'independent-stream')
  try {
    await Promise.all([stream.initial, independent.initial])
    expect(runtime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled).toBe(
      true
    )
    independent.stop()
    await independent.completion
    vi.setSystemTime(Date.now() + 46_000)
    runtime.notifyMobileSessionTabsChanged(WORKSPACE)
    runtime.onMobileSessionTabsChanged(() => {}, 'flush-device', 'mobile')()
    expect(stream.frames.at(-1)?.clientHostedPagesUnreconciled).toBeUndefined()
    runtime.projectedFrames = 0
    const delivered = stream.frames.length
    runtime.markClientHostedPagesReconciled('device-a')
    expect(runtime.projectedFrames).toBe(1)
    expect(stream.frames).toHaveLength(delivered + 1)
    expect(stream.frames.at(-1)?.clientHostedPagesUnreconciled).toBeUndefined()
    stream.stop()
    await stream.completion
    vi.setSystemTime(Date.now() - 46_000)
    const removed = openRecoveryTabsStream(runtime, 'removed-stream', undefined, 'device-b')
    await removed.initial
    expect(
      removed.frames.findLast((frame) => frame.worktree === WORKSPACE)
        ?.clientHostedPagesUnreconciled
    ).toBe(true)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    runtime.projectedFrames = 0
    runtime.markClientHostedPagesReconciled('device-b')
    expect(runtime.projectedFrames).toBe(0)
    removed.stop()
    await removed.completion
  } finally {
    stream.stop()
    independent.stop()
    await h.close()
    vi.useRealTimers()
  }
})

it('cannot recreate a raw observation when its listener unsubscribes during delivery', async () => {
  const h = createReconciliationDeliveryRuntime()
  let unsubscribe = () => {}
  try {
    unsubscribe = h.hostRuntime.onMobileSessionTabsChanged(
      () => unsubscribe(),
      'device-a',
      'mobile'
    )
    h.hostRuntime.notifyMobileSessionTabsChanged(WORKSPACE)
    h.hostRuntime.onMobileSessionTabsChanged(() => {}, 'flush-device', 'mobile')()
    h.hostRuntime.projectedFrames = 0
    h.hostRuntime.markClientHostedPagesReconciled('device-a')
    expect(h.hostRuntime.projectedFrames).toBe(0)
  } finally {
    unsubscribe()
    await h.close()
  }
})

it.each(['session.tabs.subscribe', 'session.tabs.subscribeAll'])(
  'cannot recreate %s observations when initial output releases the stream',
  async (method) => {
    const h = createReconciliationDeliveryRuntime()
    h.hostRuntime.attachWindow(1)
    h.hostRuntime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKSPACE,
          publicationEpoch: 'renderer',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    const stopped = new AbortController()
    const rpc = new RpcDispatcher({ runtime: h.hostRuntime, methods: SESSION_TAB_METHODS })
    try {
      let supplied = false
      await rpc.dispatchStreaming(
        {
          id: 'release-during-output',
          authToken: 'test',
          method,
          params: method === 'session.tabs.subscribe' ? { worktree: `id:${WORKSPACE}` } : {}
        },
        (reply) => {
          if (['snapshot', 'snapshots'].includes(JSON.parse(reply).result?.type)) {
            supplied = true
            stopped.abort()
          }
        },
        {
          connectionId: 'release-during-output',
          pairedDeviceId: 'device-a',
          clientKind: 'mobile',
          signal: stopped.signal
        }
      )
      expect(supplied).toBe(true)
      h.hostRuntime.projectedFrames = 0
      h.hostRuntime.markClientHostedPagesReconciled('device-a')
      expect(h.hostRuntime.projectedFrames).toBe(0)
    } finally {
      stopped.abort()
      await h.close()
    }
  }
)
