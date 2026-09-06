import { describe, expect, it, vi } from 'vitest'
import { navigateHostedWebViewRoute } from '../../scripts/hosted-webview-route-navigation.mjs'

describe('hosted WebView route navigation', () => {
  it('moves within the authenticated hosted SPA without a document navigation', async () => {
    const socket = cdpSocket('/h/host/review/workspace')

    await expect(
      navigateHostedWebViewRoute(
        { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' },
        '/h/host/review/workspace?scope=all',
        socket.WebSocket
      )
    ).resolves.toBeUndefined()

    expect(socket.expression()).toContain('history.pushState')
    expect(socket.expression()).toContain("dispatchEvent(new PopStateEvent('popstate'")
  })

  it('rejects routes outside the hosted app graph', async () => {
    const socket = cdpSocket('')

    await expect(
      navigateHostedWebViewRoute(
        { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' },
        'https://example.test/',
        socket.WebSocket
      )
    ).rejects.toThrow('route is invalid')
    expect(socket.expression()).toBe('')
  })
})

function cdpSocket(value: string) {
  let expression = ''
  class FakeWebSocket {
    private message: ((data: Buffer) => void) | undefined

    once(event: string, listener: (error?: Error) => void) {
      if (event === 'open') {
        queueMicrotask(listener)
      }
    }

    on(event: string, listener: (data: Buffer) => void) {
      if (event === 'message') {
        this.message = listener
      }
    }

    send(payload: string) {
      expression = JSON.parse(payload).params.expression
      queueMicrotask(() => {
        this.message?.(Buffer.from(JSON.stringify({ id: 1, result: { result: { value } } })))
      })
    }

    close() {}
  }

  return {
    WebSocket: FakeWebSocket as never,
    expression: vi.fn(() => expression)
  }
}
