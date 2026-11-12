import { expect, it, vi } from 'vitest'
import { createReconciliationDeliveryRuntime } from './client-page-reconciliation-delivery-test-harness'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../rpc/methods/session-tabs/session-tabs'

import { openRecoveryTabsStream } from './client-page-recovery-stream-test-harness'

const WORKSPACE = 'repo-1::/tmp/worktree-a'

it.each(['session.tabs.subscribe', 'session.tabs.subscribeAll'])(
  'forgets %s initial hold after the same stream receives an unheld frame',
  async (method) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = createReconciliationDeliveryRuntime()
    const runtime = h.hostRuntime
    const stopped = new AbortController()
    const replies: string[] = []
    try {
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
      const rpc = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
      const stream = rpc.dispatchStreaming(
        {
          id: 'held-stream',
          authToken: 'test',
          method,
          params: method === 'session.tabs.subscribe' ? { worktree: `id:${WORKSPACE}` } : {}
        },
        (reply) => replies.push(reply),
        {
          connectionId: 'held-connection',
          pairedDeviceId: 'device-a',
          clientKind: 'mobile',
          signal: stopped.signal
        }
      )
      await vi.waitFor(() =>
        expect(
          replies.some((reply) =>
            ['snapshots', 'snapshot'].includes(JSON.parse(reply).result?.type)
          )
        ).toBe(true)
      )
      expect(
        replies.some((reply) =>
          (JSON.parse(reply).result?.snapshots ?? [JSON.parse(reply).result]).some(
            (frame: { worktree: string; clientHostedPagesUnreconciled?: true }) =>
              frame.worktree === WORKSPACE && frame.clientHostedPagesUnreconciled
          )
        )
      ).toBe(true)
      vi.setSystemTime(Date.now() + 46_000)
      runtime.notifyMobileSessionTabsChanged(WORKSPACE)
      expect(
        replies.some(
          (reply) =>
            JSON.parse(reply).result?.type === 'updated' &&
            JSON.parse(reply).result?.clientHostedPagesUnreconciled === undefined
        )
      ).toBe(true)
      runtime.projectedFrames = 0
      const delivered = replies.length
      runtime.markClientHostedPagesReconciled('device-a')
      expect(runtime.projectedFrames).toBe(0)
      expect(replies).toHaveLength(delivered)
      stopped.abort()
      await stream
    } finally {
      stopped.abort()
      await h.close()
      vi.useRealTimers()
    }
  }
)

it('delivers a cleared snapshot when authenticated empty adoption completes without another workspace change', async () => {
  const h = createReconciliationDeliveryRuntime()
  const stream = openRecoveryTabsStream(h.hostRuntime, 'empty-adoption-consumer')
  try {
    await stream.initial
    expect(
      stream.frames.findLast((frame) => frame.worktree === WORKSPACE)?.clientHostedPagesUnreconciled
    ).toBe(true)
    const attached = h.attach()
    await vi.waitFor(() =>
      expect(
        stream.frames.findLast((frame) => frame.worktree === WORKSPACE)
          ?.clientHostedPagesUnreconciled
      ).toBeUndefined()
    )
    expect(stream.errors).toEqual([])
    attached.abort()
    await attached.completion
  } finally {
    stream.stop()
    await stream.completion
    await h.close()
  }
})
