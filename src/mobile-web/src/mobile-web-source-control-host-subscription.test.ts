import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import { subscribeHostSourceControl } from './mobile-web-source-control-host-subscription'
import type { MobileWebSourceControlStatusInvalidation } from '../../shared/mobile-web/source-control-operation-contract'

const PAYLOAD = { workspaceId: 'page-workspace' }

function harness() {
  const unsubscribe = vi.fn()
  const events: MobileWebSourceControlStatusInvalidation[] = []
  const errors: { code: string; retryable: boolean }[] = []
  let deliver: ((event: unknown) => void) | undefined
  let fail: ((error: MobileWebBridgeClientError) => void) | undefined
  const subscribeHost = vi.fn((_payload, onHostEvent, onHostError) => {
    deliver = onHostEvent
    fail = onHostError
    return { ready: Promise.resolve(), unsubscribe }
  })
  const subscription = subscribeHostSourceControl(
    { subscribeHost } as unknown as MobileWebBridgeSubscriptionClient,
    PAYLOAD,
    (event) => events.push(event),
    (error) => errors.push({ code: error.code, retryable: error.retryable })
  )
  return {
    errors,
    events,
    subscribeHost,
    subscription,
    unsubscribe,
    deliver: (event: unknown) => deliver?.(event),
    fail: (error: MobileWebBridgeClientError) => fail?.(error)
  }
}

describe('host-projected Source Control subscription', () => {
  it('subscribes over the generic host watch without naming the host workspace', async () => {
    const h = harness()
    await h.subscription.ready

    expect(h.subscribeHost).toHaveBeenCalledWith(
      { method: 'mobileWeb.files.watch', workspaceId: 'page-workspace', params: {} },
      expect.any(Function),
      expect.any(Function)
    )
  })

  it('reports a watcher failure once as retryable and delivers no invalidation', () => {
    const h = harness()

    h.deliver({ type: 'error', message: 'watch failed', rootPath: '/private/repo' })

    expect(h.errors).toEqual([{ code: 'unavailable', retryable: true }])
    expect(h.events).toEqual([])
    expect(JSON.stringify(h.errors)).not.toContain('/private/repo')
  })

  it('retires the host subscription and stops reporting once the page unsubscribes', () => {
    const h = harness()

    h.deliver({ type: 'error', message: 'watch failed' })
    h.subscription.unsubscribe()
    h.deliver({ type: 'end' })
    h.deliver({ type: 'changed', events: [] })
    h.fail({ code: 'unavailable', retryable: true } as MobileWebBridgeClientError)

    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(h.errors).toEqual([{ code: 'unavailable', retryable: true }])
    expect(h.events).toEqual([])
  })

  it('reports a normal end-of-watch as retryable', () => {
    const h = harness()

    h.deliver({ type: 'end' })

    expect(h.errors).toEqual([{ code: 'unavailable', retryable: true }])
  })

  it('rejects a malformed payload before it reaches the host', async () => {
    const errors: { code: string; retryable: boolean }[] = []
    const subscribeHost = vi.fn()
    const subscription = subscribeHostSourceControl(
      { subscribeHost } as unknown as MobileWebBridgeSubscriptionClient,
      { workspaceId: '' },
      vi.fn(),
      (error) => errors.push({ code: error.code, retryable: error.retryable })
    )

    await expect(subscription.ready).rejects.toMatchObject({ code: 'invalid_request' })
    await vi.waitFor(() => expect(errors).toEqual([{ code: 'invalid_request', retryable: false }]))
    expect(subscribeHost).not.toHaveBeenCalled()
  })

  it('reports a changed batch the watcher could not bound as an overflow invalidation', () => {
    const h = harness()

    h.deliver({ type: 'changed', events: [{ kind: 'overflow', absolutePath: '/private/repo' }] })
    h.deliver({ type: 'changed', events: [{ kind: 'update', absolutePath: '/private/repo/a.ts' }] })

    expect(h.events).toEqual([
      { workspaceId: 'page-workspace', reason: 'overflow' },
      { workspaceId: 'page-workspace', reason: 'changed' }
    ])
    expect(JSON.stringify(h.events)).not.toContain('/private/repo')
  })

  it('fails an unreadable changed frame instead of publishing an empty invalidation', () => {
    const h = harness()

    h.deliver({ type: 'changed' })

    expect(h.errors).toEqual([{ code: 'invalid_message', retryable: false }])
    expect(h.events).toEqual([])
  })
})
