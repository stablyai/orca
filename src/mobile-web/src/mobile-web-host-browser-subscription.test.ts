import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBrowserEvent } from '../../shared/mobile-web/browser-operation-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import { subscribeMobileWebHostBrowser } from './mobile-web-host-browser-subscription'

const PAYLOAD = {
  workspaceId: 'workspace-1',
  pageId: 'browser-1',
  format: 'jpeg' as const,
  quality: 72,
  maxWidth: 800,
  maxHeight: 600,
  everyNthFrame: 1,
  minFrameIntervalMs: 100
}

function fixture() {
  const unsubscribe = vi.fn()
  let emit: (event: unknown) => void = () => {}
  const subscribeHost = vi.fn((_payload: unknown, onEvent: (event: unknown) => void) => {
    emit = onEvent
    return { ready: Promise.resolve(), unsubscribe }
  })
  const subscriptions = { subscribeHost } as unknown as MobileWebBridgeSubscriptionClient
  const events: MobileWebBrowserEvent[] = []
  const errors: MobileWebBridgeClientError[] = []
  const subscription = subscribeMobileWebHostBrowser(
    subscriptions,
    PAYLOAD,
    (event) => events.push(event),
    (error) => errors.push(error)
  )
  return { emit: (event: unknown) => emit(event), errors, events, subscribeHost, subscription }
}

describe('page-owned browser stream', () => {
  it('opens the host stream with the page id and the screencast request', () => {
    const f = fixture()

    expect(f.subscribeHost.mock.calls[0]![0]).toEqual({
      method: 'mobileWeb.browser.subscribe',
      workspaceId: 'workspace-1',
      params: {
        page: 'browser-1',
        format: 'jpeg',
        quality: 72,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
        minFrameIntervalMs: 100
      }
    })
  })

  it('swallows the lane handshake and delivers the browser ready that carries tab state', () => {
    const f = fixture()
    const tab = { url: 'https://a.example/', title: 'A', canGoBack: false, canGoForward: false }

    f.emit({ type: 'ready', subscriptionId: 'lane-id' })
    f.emit({ type: 'ready', tab })

    expect(f.events).toEqual([{ type: 'ready', tab }])
    expect(f.errors).toEqual([])
  })

  it('reports an event the browser contract cannot describe', () => {
    const f = fixture()

    f.emit({ type: 'frameChunk', chunkIndex: 4, chunkCount: 1 })

    expect(f.events).toEqual([])
    expect(f.errors.map((error) => error.code)).toEqual(['invalid_message'])
  })

  it('stops delivering once the page unsubscribes', () => {
    const f = fixture()

    f.subscription.unsubscribe()
    f.emit({ type: 'dialogClosed' })

    expect(f.events).toEqual([])
  })

  it('refuses a screencast request the contract does not admit', async () => {
    const errors: MobileWebBridgeClientError[] = []
    const subscribeHost = vi.fn()
    const subscription = subscribeMobileWebHostBrowser(
      { subscribeHost } as unknown as MobileWebBridgeSubscriptionClient,
      { ...PAYLOAD, quality: 0 },
      () => {},
      (error) => errors.push(error)
    )

    await expect(subscription.ready).rejects.toMatchObject({ code: 'invalid_request' })
    await Promise.resolve()
    expect(subscribeHost).not.toHaveBeenCalled()
    expect(errors.map((error) => error.code)).toEqual(['invalid_request'])
  })
})
