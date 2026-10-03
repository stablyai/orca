/**
 * `files.unwatch` must not reply before @parcel/watcher is released: the reply is the only
 * signal a client waits on, so a client that rewatches on it would otherwise hold two watchers
 * on one path and get every change twice. That guarantee already holds — this pins it, because
 * nothing else did, and a reviewer reading the handler cannot tell the await is load-bearing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { FILE_METHODS } from './files'

function unwatchRequest(subscriptionId: string): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'files.unwatch', params: { subscriptionId } }
}

describe('files.unwatch teardown', () => {
  it('does not reply until the watcher release settles', async () => {
    const subscriptions = new RuntimeSubscriptionRegistry()
    let releaseWatcher: (() => void) | undefined
    let released = false
    subscriptions.register(
      'files-watch-slow-1',
      () =>
        new Promise<void>((resolve) => {
          releaseWatcher = () => {
            released = true
            resolve()
          }
        }),
      'conn-owner'
    )
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscriptionAndWait: subscriptions.cleanupAndWait.bind(subscriptions)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    let settled = false
    const pending = dispatcher
      .dispatch(unwatchRequest('files-watch-slow-1'), { connectionId: 'conn-owner' })
      .then((response) => {
        settled = true
        return response
      })

    await vi.waitFor(() => expect(releaseWatcher).toBeDefined())
    expect(settled).toBe(false)
    expect(released).toBe(false)

    releaseWatcher?.()
    await expect(pending).resolves.toMatchObject({ ok: true, result: { unsubscribed: true } })
    expect(released).toBe(true)
  })

  it('holds one watcher when the owner rewatches straight after the unwatch reply', async () => {
    const subscriptions = new RuntimeSubscriptionRegistry()
    let liveWatchers = 0
    let peakLiveWatchers = 0
    const pendingReleases: (() => void)[] = []
    const watchFileExplorer = vi.fn(async () => {
      liveWatchers += 1
      peakLiveWatchers = Math.max(peakLiveWatchers, liveWatchers)
      return () =>
        new Promise<void>((resolve) => {
          pendingReleases.push(() => {
            liveWatchers -= 1
            resolve()
          })
        })
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      watchFileExplorer,
      registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
      cleanupSubscription: subscriptions.cleanup.bind(subscriptions),
      cleanupSubscriptionAndWait: subscriptions.cleanupAndWait.bind(subscriptions)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const watch = (
      id: string
    ): { done: Promise<unknown>; events: { type?: string; subscriptionId?: string }[] } => {
      const events: { type?: string; subscriptionId?: string }[] = []
      const done = dispatcher.dispatchStreaming(
        { id, authToken: 'tok', method: 'files.watch', params: { worktree: 'id:wt-1' } },
        (reply) => {
          const parsed = JSON.parse(reply) as {
            result?: { type?: string; subscriptionId?: string }
          }
          if (parsed.result) {
            events.push(parsed.result)
          }
        },
        { connectionId: 'conn-owner' }
      )
      return { done, events }
    }

    const first = watch('watch-1')
    await vi.waitFor(() => expect(first.events.some((event) => event.type === 'ready')).toBe(true))
    const subscriptionId = first.events[0]?.subscriptionId
    expect(subscriptionId).toBeTruthy()
    expect(liveWatchers).toBe(1)

    let unwatchSettled = false
    const unwatch = dispatcher
      .dispatch(unwatchRequest(subscriptionId!), { connectionId: 'conn-owner' })
      .then((response) => {
        unwatchSettled = true
        return response
      })
    await vi.waitFor(() => expect(pendingReleases).toHaveLength(1))
    expect(unwatchSettled).toBe(false)

    pendingReleases[0]?.()
    await expect(unwatch).resolves.toMatchObject({ ok: true, result: { unsubscribed: true } })
    await first.done
    expect(liveWatchers).toBe(0)

    const second = watch('watch-2')
    await vi.waitFor(() => expect(second.events.some((event) => event.type === 'ready')).toBe(true))
    expect(peakLiveWatchers).toBe(1)

    const secondUnwatch = dispatcher.dispatch(unwatchRequest(second.events[0]!.subscriptionId!), {
      connectionId: 'conn-owner'
    })
    await vi.waitFor(() => expect(pendingReleases).toHaveLength(2))
    pendingReleases[1]?.()
    await secondUnwatch
    await second.done
    expect(liveWatchers).toBe(0)
  })
})
