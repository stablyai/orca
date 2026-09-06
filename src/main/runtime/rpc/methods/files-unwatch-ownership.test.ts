import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { FILE_METHODS } from './files'

function unwatchRequest(subscriptionId: string): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method: 'files.unwatch',
    params: { subscriptionId }
  }
}

describe('files.unwatch ownership', () => {
  it('refuses teardown when the socket does not own the subscription', async () => {
    const cleanupSubscriptionIfOwnedByConnectionAndWait = vi.fn().mockResolvedValue(false)
    const cleanupSubscriptionAndWait = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscriptionIfOwnedByConnectionAndWait,
      cleanupSubscriptionAndWait
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const replies: unknown[] = []

    await dispatcher.dispatchStreaming(
      unwatchRequest('files-watch-conn-owner-1'),
      (reply) => replies.push(JSON.parse(reply)),
      { connectionId: 'conn-attacker' }
    )

    expect(cleanupSubscriptionIfOwnedByConnectionAndWait).toHaveBeenCalledWith(
      'files-watch-conn-owner-1',
      'conn-attacker'
    )
    expect(cleanupSubscriptionAndWait).not.toHaveBeenCalled()
    expect(replies).toEqual([expect.objectContaining({ result: { unsubscribed: false } })])
  })

  // Why: returning before @parcel/watcher is released lets a rewatch hold two watchers.
  it('does not reply until the owning connection teardown settles', async () => {
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
      cleanupSubscriptionIfOwnedByConnectionAndWait:
        subscriptions.cleanupIfOwnedByConnectionAndWait.bind(subscriptions)
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
})
