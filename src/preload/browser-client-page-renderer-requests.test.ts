import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientPageRendererReply,
  BrowserClientPageRendererRequest
} from '../shared/browser-client-page-renderer-protocol'
import { createBrowserClientPageRendererRequests } from './browser-client-page-renderer-requests'

type Listener = (event: unknown, request: unknown) => void

class FakeIpc {
  readonly listeners = new Map<string, Listener>()
  readonly sent: { channel: string; reply: BrowserClientPageRendererReply }[] = []
  failNextSend = false

  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener)
  }

  removeListener(channel: string, listener: Listener): void {
    if (this.listeners.get(channel) === listener) {
      this.listeners.delete(channel)
    }
  }

  send(channel: string, reply: BrowserClientPageRendererReply): void {
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error('renderer transport closed')
    }
    this.sent.push({ channel, reply })
  }

  emit(request: unknown): void {
    this.listeners.get('browser:clientPageRendererRequest')?.({}, request)
  }
}

const PAGE = {
  partition: 'persist:route-a',
  browserPageId: 'page-a',
  pageHostGeneration: 7
}

function request(
  requestId: string,
  type: Exclude<BrowserClientPageRendererRequest['type'], 'rekeyPage'> = 'mountPage'
): BrowserClientPageRendererRequest {
  return { requestId, type, page: PAGE }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('browser client page renderer preload requests', () => {
  it('echoes the exact immutable rekey target through the current subscriber', async () => {
    const ipc = new FakeIpc()
    const requests = createBrowserClientPageRendererRequests({ ipc, isTopFrame: () => true })
    const nextPage = { ...PAGE, pageHostGeneration: 8 }
    const callback = vi.fn(() => ({ type: 'rekeyed' as const }))
    requests.subscribe(callback)

    ipc.emit({ requestId: 'rekey-a', type: 'rekeyPage', page: PAGE, nextPage })
    nextPage.pageHostGeneration = 9
    await flush()

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'rekeyPage',
        page: PAGE,
        nextPage: { ...PAGE, pageHostGeneration: 8 }
      })
    )
    expect(ipc.sent[0]?.reply).toEqual({
      type: 'rekeyed',
      requestId: 'rekey-a',
      page: PAGE,
      nextPage: { ...PAGE, pageHostGeneration: 8 }
    })
  })

  it('queues before subscription and dispatches in arrival order', async () => {
    const ipc = new FakeIpc()
    const requests = createBrowserClientPageRendererRequests({ ipc, isTopFrame: () => true })
    ipc.emit(request('request-a'))
    ipc.emit(request('request-b', 'retirePage'))
    const dispatched: string[] = []

    requests.subscribe((input) => {
      dispatched.push(input.requestId)
      return input.type === 'mountPage'
        ? { type: 'mounted', webContentsId: 41 }
        : { type: 'retired' }
    })
    await flush()

    expect(dispatched).toEqual(['request-a', 'request-b'])
    expect(ipc.sent.map(({ reply }) => reply.type)).toEqual(['mounted', 'retired'])
  })

  it('fails overflow immediately and times out a missing subscriber', async () => {
    vi.useFakeTimers()
    const ipc = new FakeIpc()
    createBrowserClientPageRendererRequests({
      ipc,
      isTopFrame: () => true,
      maxPending: 2,
      timeoutMs: 50
    })
    ipc.emit(request('request-a'))
    ipc.emit(request('request-b'))
    ipc.emit(request('request-c'))

    expect(ipc.sent).toHaveLength(1)
    expect(ipc.sent[0]?.reply).toMatchObject({
      requestId: 'request-c',
      type: 'failed',
      errorCode: 'browser_client_page_renderer_request_capacity'
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(
      ipc.sent.slice(1).map(({ reply }) => (reply.type === 'failed' ? reply.errorCode : null))
    ).toEqual([
      'browser_client_page_renderer_subscriber_timeout',
      'browser_client_page_renderer_subscriber_timeout'
    ])
  })

  it('lets the latest subscriber take over and fences the replaced callback', async () => {
    const ipc = new FakeIpc()
    const requests = createBrowserClientPageRendererRequests({ ipc, isTopFrame: () => true })
    let settleFirst: (value: { type: 'mounted'; webContentsId: number }) => void = () => {
      throw new Error('first subscriber was not dispatched')
    }
    requests.subscribe(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve
        })
    )
    ipc.emit(request('request-a'))
    await flush()
    const second = vi.fn(() => ({ type: 'mounted' as const, webContentsId: 52 }))

    requests.subscribe(second)
    ipc.emit(request('request-b'))
    settleFirst({ type: 'mounted', webContentsId: 51 })
    await flush()

    expect(second).toHaveBeenCalledOnce()
    expect(ipc.sent.map(({ reply }) => reply)).toEqual([
      expect.objectContaining({
        requestId: 'request-a',
        type: 'failed',
        errorCode: 'browser_client_page_renderer_subscriber_replaced'
      }),
      expect.objectContaining({ requestId: 'request-b', type: 'mounted', webContentsId: 52 })
    ])
  })

  it('ignores subframes, malformed requests, and duplicate request ids', async () => {
    const subframeIpc = new FakeIpc()
    const subframe = createBrowserClientPageRendererRequests({
      ipc: subframeIpc,
      isTopFrame: () => false
    })
    expect(subframeIpc.listeners.size).toBe(0)
    expect(() => subframe.subscribe(() => ({ type: 'retired' }))).toThrow(
      'browser_client_page_renderer_top_frame_required'
    )

    const ipc = new FakeIpc()
    const requests = createBrowserClientPageRendererRequests({ ipc, isTopFrame: () => true })
    const callback = vi.fn(() => ({ type: 'mounted' as const, webContentsId: 61 }))
    requests.subscribe(callback)
    ipc.emit({ requestId: '', type: 'mountPage', page: PAGE })
    ipc.emit(request('request-a'))
    ipc.emit(request('request-a'))
    await flush()

    expect(callback).toHaveBeenCalledOnce()
    expect(ipc.sent).toHaveLength(1)
  })

  it('binds replies to the admitted request and fails a mismatched result', async () => {
    const ipc = new FakeIpc()
    const requests = createBrowserClientPageRendererRequests({ ipc, isTopFrame: () => true })
    requests.subscribe((input) =>
      input.requestId === 'request-a'
        ? ({ type: 'mounted', webContentsId: 71, requestId: 'spoofed' } as never)
        : { type: 'retired' }
    )

    ipc.emit(request('request-a'))
    ipc.emit(request('request-b'))
    await flush()

    expect(ipc.sent[0]?.reply).toMatchObject({
      requestId: 'request-a',
      page: PAGE,
      type: 'mounted',
      webContentsId: 71
    })
    expect(ipc.sent[1]?.reply).toMatchObject({
      requestId: 'request-b',
      type: 'failed',
      operation: 'mountPage',
      errorCode: 'browser_client_page_renderer_result_invalid'
    })
  })

  it('contains a reply transport failure after local settlement', async () => {
    const ipc = new FakeIpc()
    const requests = createBrowserClientPageRendererRequests({ ipc, isTopFrame: () => true })
    const callback = vi.fn(() => ({ type: 'mounted' as const, webContentsId: 81 }))
    requests.subscribe(callback)
    ipc.failNextSend = true

    ipc.emit(request('request-a'))
    await flush()
    ipc.emit(request('request-a'))
    await flush()

    expect(callback).toHaveBeenCalledTimes(2)
    expect(ipc.sent).toHaveLength(1)
  })
})
