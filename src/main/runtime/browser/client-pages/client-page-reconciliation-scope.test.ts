import { expect, it, vi } from 'vitest'
import { RuntimeAgentSenderAssociations } from '../../agent-senders/runtime-agent-sender-associations'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../rpc/methods/session-tabs/session-tabs'
import { createReconciliationDeliveryRuntime } from './client-page-reconciliation-delivery-test-harness'
import { openRecoveryTabsStream } from './client-page-recovery-stream-test-harness'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

function snapshots(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    worktree: `repo-1::/tmp/covered-${index}`,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }))
}

it.each([750, 7500])(
  'clears only the live workspace channel among %i held read replies',
  async (count) => {
    const h = createReconciliationDeliveryRuntime()
    const runtime = h.hostRuntime
    const corpus = snapshots(count)
    const workspace = corpus[0]!.worktree
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: corpus })
    const global = openRecoveryTabsStream(runtime, 'departing-global')
    const active = openRecoveryTabsStream(
      runtime,
      'surviving-active',
      `id:${workspace}`,
      'device-a',
      'runtime'
    )
    const refresh = vi.spyOn(runtime.sidebarFacts!.workspaceActivityFacts, 'refreshWorkspace')
    const senderWorkspaces: string[] = []
    const build = RuntimeAgentSenderAssociations.prototype.buildForFramePass
    const senderPass = vi
      .spyOn(RuntimeAgentSenderAssociations.prototype, 'buildForFramePass')
      .mockImplementation(function (this: RuntimeAgentSenderAssociations) {
        const scope = build.call(this)
        return (worktree) => {
          senderWorkspaces.push(worktree)
          return scope(worktree)
        }
      })
    try {
      await Promise.all([global.initial, active.initial])
      const rpc = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
      const reads: string[] = []
      await rpc.dispatchStreaming(
        { id: 'held-census', authToken: 'test', method: 'session.tabs.listAll', params: {} },
        (reply) => reads.push(reply),
        { connectionId: 'held-census', pairedDeviceId: 'device-a', clientKind: 'runtime' }
      )
      const supplied = JSON.parse(reads[0]!).result.snapshots
      expect(supplied).toHaveLength(count)
      expect(
        supplied.every(
          (frame: { clientHostedPagesUnreconciled?: true }) =>
            frame.clientHostedPagesUnreconciled === true
        )
      ).toBe(true)
      expect(active.frames.at(-1)?.clientHostedPagesUnreconciled).toBe(true)
      global.stop()
      await global.completion
      runtime.projectedFrames = 0
      senderWorkspaces.length = 0
      refresh.mockClear()
      const sequence = runtime.sessionTabsSequence()
      const delivered = active.frames.length
      runtime.markClientHostedPagesReconciled('device-a')
      expect(runtime.projectedFrames).toBe(1)
      expect(runtime.sessionTabsSequence()).toBe(sequence + 1)
      expect(active.frames).toHaveLength(delivered + 1)
      expect(active.frames.at(-1)).toMatchObject({ worktree: workspace })
      expect(active.frames.at(-1)?.clientHostedPagesUnreconciled).toBeUndefined()
      expect(senderWorkspaces).toEqual([workspace])
      expect(refresh).not.toHaveBeenCalled()
      runtime.markClientHostedPagesReconciled('device-a')
      expect(runtime.projectedFrames).toBe(1)
      expect(runtime.sessionTabsSequence()).toBe(sequence + 1)
      runtime.projectedFrames = 0
      senderWorkspaces.length = 0
      runtime.notifyMobileSessionTabsChanged(corpus[1]!.worktree)
      runtime.onMobileSessionTabsChanged(() => {}, 'flush-device', 'mobile')()
      expect(runtime.projectedFrames).toBe(0)
      expect(senderWorkspaces).toEqual([])
      expect(active.frames).toHaveLength(delivered + 1)
      const later = openRecoveryTabsStream(runtime, 'later-uncovered', `id:${corpus[1]!.worktree}`)
      await later.initial
      expect(later.frames.at(-1)?.clientHostedPagesUnreconciled).toBeUndefined()
      later.stop()
      await later.completion
    } finally {
      global.stop()
      active.stop()
      await Promise.all([global.completion, active.completion])
      await h.close()
      refresh.mockRestore()
      senderPass.mockRestore()
    }
  }
)

it('stops projecting remaining owed workspaces when clearing output releases the stream', async () => {
  const h = createReconciliationDeliveryRuntime()
  const runtime = h.hostRuntime
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots(2) })
  const stopped = new AbortController()
  const rpc = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const cleared: string[] = []
  try {
    await rpc.dispatchStreaming(
      {
        id: 'release-on-clear',
        authToken: 'test',
        method: 'session.tabs.subscribeAll',
        params: {}
      },
      (reply) => {
        const frame = JSON.parse(reply).result
        if (frame?.type === 'updated') {
          cleared.push(frame.worktree)
          stopped.abort()
        }
      },
      {
        connectionId: 'release-on-clear',
        pairedDeviceId: 'device-a',
        clientKind: 'mobile',
        signal: stopped.signal
      }
    )
    runtime.projectedFrames = 0
    const sequence = runtime.sessionTabsSequence()
    runtime.markClientHostedPagesReconciled('device-a')
    expect(cleared).toEqual(['repo-1::/tmp/covered-0'])
    expect(runtime.projectedFrames).toBe(1)
    expect(runtime.sessionTabsSequence()).toBe(sequence + 1)
  } finally {
    stopped.abort()
    await h.close()
  }
})
