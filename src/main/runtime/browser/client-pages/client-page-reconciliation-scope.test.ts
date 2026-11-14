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
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: corpus })
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
      await runtime.markClientHostedPagesReconciled('device-a')
      expect(runtime.projectedFrames).toBe(1)
      expect(runtime.sessionTabsSequence()).toBe(sequence + 1)
      expect(active.frames).toHaveLength(delivered + 1)
      expect(active.frames.at(-1)).toMatchObject({ worktree: workspace })
      expect(active.frames.at(-1)?.clientHostedPagesUnreconciled).toBeUndefined()
      expect(senderWorkspaces).toEqual([workspace])
      expect(refresh).not.toHaveBeenCalled()
      await runtime.markClientHostedPagesReconciled('device-a')
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
  await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: snapshots(2) })
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
    await runtime.markClientHostedPagesReconciled('device-a')
    expect(cleared).toEqual(['repo-1::/tmp/covered-0'])
    expect(runtime.projectedFrames).toBe(1)
    expect(runtime.sessionTabsSequence()).toBe(sequence + 1)
  } finally {
    stopped.abort()
    await h.close()
  }
})

it('refreshes sender scopes only through accepting desktop channels and settles after broad delivery', async () => {
  const h = createReconciliationDeliveryRuntime()
  const runtime = h.hostRuntime
  const corpus = snapshots(2)
  const activeWorkspace = corpus[0]!.worktree
  const otherWorkspace = corpus[1]!.worktree
  let peerKey = 'sender-peer-before'
  runtime.setAgentSenderPeerKey(() => peerKey)
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: corpus })
  const initial = openRecoveryTabsStream(
    runtime,
    'initial-sender-census',
    undefined,
    'device-a',
    'runtime'
  )
  const active = openRecoveryTabsStream(
    runtime,
    'active-sender-scope',
    `id:${activeWorkspace}`,
    'device-a',
    'runtime'
  )
  const phone = openRecoveryTabsStream(
    runtime,
    'phone-sender-witness',
    `id:${otherWorkspace}`,
    'phone'
  )
  let broad: ReturnType<typeof openRecoveryTabsStream> | undefined
  try {
    await Promise.all([initial.initial, active.initial, phone.initial])
    initial.stop()
    await initial.completion
    const before = phone.frames.at(-1)!.snapshotVersion
    const beforeCount = phone.frames.length
    peerKey = 'sender-peer-after'
    await runtime.refreshAgentSenderAssociations()
    runtime.onMobileSessionTabsChanged(() => {}, 'flush', 'mobile')()
    await runtime.refreshAgentSenderAssociations()
    runtime.onMobileSessionTabsChanged(() => {}, 'flush', 'mobile')()
    expect(phone.frames.at(-1)!.snapshotVersion).toBe(before)
    expect(phone.frames).toHaveLength(beforeCount)
    broad = openRecoveryTabsStream(
      runtime,
      'returning-sender-census',
      undefined,
      'device-a',
      'runtime'
    )
    await broad.initial
    const refreshed = broad.frames.findLast((frame) => frame.worktree === otherWorkspace)
    expect(refreshed?.agentSenderAssociations?.peerFingerprint).toBe(
      'pXI0wdMoVIozNMf8PhOCNlB9sTAAEaBF6DfNP9doYqk'
    )
    await runtime.refreshAgentSenderAssociations()
    runtime.onMobileSessionTabsChanged(() => {}, 'flush', 'mobile')()
    const settled = phone.frames.length
    const version = phone.frames.at(-1)!.snapshotVersion
    await runtime.refreshAgentSenderAssociations()
    runtime.onMobileSessionTabsChanged(() => {}, 'flush', 'mobile')()
    expect(phone.frames).toHaveLength(settled)
    expect(phone.frames.at(-1)!.snapshotVersion).toBe(version)
  } finally {
    initial.stop()
    active.stop()
    phone.stop()
    broad?.stop()
    await Promise.all([initial.completion, active.completion, phone.completion, broad?.completion])
    await h.close()
  }
})

it('routes removal only to the matching workspace and broad RPC streams', async () => {
  const h = createReconciliationDeliveryRuntime()
  const runtime = h.hostRuntime
  const corpus = snapshots(2)
  const keptWorkspace = corpus[0]!.worktree
  const removedWorkspace = corpus[1]!.worktree
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: corpus })
  const kept = openRecoveryTabsStream(runtime, 'kept-workspace', `id:${keptWorkspace}`)
  const removed = openRecoveryTabsStream(runtime, 'removed-workspace', `id:${removedWorkspace}`)
  const all = openRecoveryTabsStream(runtime, 'all-workspaces')
  try {
    await Promise.all([kept.initial, removed.initial, all.initial])
    const delivered = kept.frames.length
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [corpus[0]!] })
    runtime.onMobileSessionTabsChanged(() => {}, 'flush', 'mobile')()
    expect(kept.frames).toHaveLength(delivered)
    expect(removed.frames.at(-1)).toMatchObject({ worktree: removedWorkspace, removed: true })
    expect(all.frames.at(-1)).toMatchObject({ worktree: removedWorkspace, removed: true })
  } finally {
    kept.stop()
    removed.stop()
    all.stop()
    await Promise.all([kept.completion, removed.completion, all.completion])
    await h.close()
  }
})

it.each([10, 100])(
  'uses one sender refresh for a full %i-workspace notification',
  async (count) => {
    const h = createReconciliationDeliveryRuntime()
    const runtime = h.hostRuntime
    const corpus = snapshots(count)
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: corpus })
    const frames: string[] = []
    let complete!: () => void
    const delivered = new Promise<void>((resolve) => {
      complete = resolve
    })
    const detach = runtime.onMobileSessionTabsChanged(
      (frame) => {
        frames.push(frame.worktree)
        if (frames.length === count) {
          complete()
        }
      },
      'sender-contract',
      'runtime'
    )
    const pass = vi.spyOn(RuntimeAgentSenderAssociations.prototype, 'buildForFramePass')
    const refresh = vi.spyOn(RuntimeAgentSenderAssociations.prototype, 'build')
    try {
      runtime.notifyMobileSessionTabsChanged()
      await delivered
      expect(frames).toEqual(corpus.map((snapshot) => snapshot.worktree))
      expect(pass).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      detach()
      pass.mockRestore()
      refresh.mockRestore()
      await h.close()
    }
  }
)
