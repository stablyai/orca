import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { RpcDispatcher } from '../../rpc/dispatcher'
import {
  openRecoveryTabsStream,
  publishRecoveryTabsGraph
} from './client-page-recovery-stream-test-harness'
import { createRecoveryPeer } from './client-page-recovery-peer-test-harness'
import { SESSION_TAB_METHODS } from '../../rpc/methods/session-tabs/session-tabs'

const WORKSPACE = 'repo-1::/tmp/worktree-a'

it.each([false, true])(
  'clears legacy held snapshots before its pending navigation, with modern peer=%s',
  async (withModern) => {
    const h = createRecoveryLoop(withModern ? [] : ['slow'])
    publishRecoveryTabsGraph(h.hostRuntime)
    const stream = openRecoveryTabsStream(h.hostRuntime, 'legacy-consumer')
    const peer = createRecoveryPeer(h.hostRuntime, 'modern-peer')
    try {
      await stream.initial
      expect(
        stream.frames.findLast((frame) => frame.worktree === WORKSPACE)
          ?.clientHostedPagesUnreconciled
      ).toBe(true)
      if (withModern) {
        h.pages.publishClientPage({
          browserPageId: 'peer',
          workspaceId: WORKSPACE,
          browserProfileId: 'profile-a',
          executionHostKey: 'old-key',
          placement: {
            kind: 'client',
            browserHostClientId: 'modern-peer',
            browserHostGeneration: 1,
            pageHostGeneration: 1
          },
          pairedDeviceId: 'device-a',
          url: 'https://example.internal/peer',
          loading: false,
          active: false
        })
        const started = peer.hold('peer')
        peer.attach()
        await started
        h.pages.publishClientPage({
          browserPageId: 'slow',
          workspaceId: WORKSPACE,
          browserProfileId: 'profile-a',
          executionHostKey: 'old-key',
          placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
          pairedDeviceId: 'device-a',
          url: 'https://example.internal/slow',
          loading: false,
          active: false
        })
      }
      expect(
        h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled
      ).toBe(true)
      const started = h.hold('slow')
      const attached = h.attach({ modern: false })
      await started
      if (withModern) {
        expect(
          stream.frames.findLast((frame) => frame.worktree === WORKSPACE)
            ?.clientHostedPagesUnreconciled
        ).toBe(true)
        peer.release('peer')
        await vi.waitFor(() => expect(h.authority.getPlacement('peer')?.kind).toBe('client'))
      }
      await vi.waitFor(() =>
        expect(
          h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled
        ).toBeUndefined()
      )
      await vi.waitFor(() =>
        expect(
          stream.frames.findLast((frame) => frame.worktree === WORKSPACE)
            ?.clientHostedPagesUnreconciled
        ).toBeUndefined()
      )
      expect(
        h.commands.some(
          (event) => event.browserPageId === 'slow' && event.command.type === 'navigate'
        )
      ).toBe(true)
      h.release('slow')
      await vi.waitFor(() =>
        expect(h.results).toContainEqual({ id: 'slow', type: 'navigate', status: 'completed' })
      )
      attached.abort()
      await attached.completion
    } finally {
      stream.stop()
      peer.release('peer')
      await h.close()
      await peer.close()
    }
  }
)

it.each(['session.tabs.subscribe', 'session.tabs.subscribeAll'])(
  'forgets %s initial hold after the same stream receives an unheld frame',
  async (method) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = createRecoveryLoop([])
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
