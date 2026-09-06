import { describe, expect, it } from 'vitest'
import { verifyHostedWebViewPrivacyIsolation } from '../../scripts/hosted-webview-privacy-isolation.mjs'

describe('hosted WebView privacy isolation', () => {
  it('accepts an empty private-origin page state', async () => {
    const socket = new FakeCdpSocket({
      href: 'orca-mobile-web://session-a/h/paired-orca-desktop',
      htmlBytes: 4096,
      domMarkers: [],
      historyMarkers: [],
      localStorageEntries: 0,
      sessionStorageEntries: 0,
      cookieBytes: 0
    })

    await expect(
      verifyHostedWebViewPrivacyIsolation({
        document: { webSocketDebuggerUrl: 'ws://localhost/page' },
        WebSocketCtor: fakeCdpConstructor(socket)
      })
    ).resolves.toMatchObject({
      privateOrigin: true,
      credentialedUrl: false,
      domCredentialMarkers: 0
    })
    expect(socket.expression).toContain('document.documentElement?.outerHTML')
  })

  it.each([
    { domMarkers: ['devicetoken'] },
    { historyMarkers: ['publickeyb64'] },
    { localStorageEntries: 1 },
    { sessionStorageEntries: 1 },
    { cookieBytes: 1 },
    { href: 'https://user:secret@orca-mobile-web.invalid/' },
    { href: 'https://orca-mobile-web.invalid/?credential=secret' }
  ])('rejects privileged page state: %j', async (overrides) => {
    const socket = new FakeCdpSocket({
      href: 'https://orca-mobile-web.invalid/#session-a',
      htmlBytes: 4096,
      domMarkers: [],
      historyMarkers: [],
      localStorageEntries: 0,
      sessionStorageEntries: 0,
      cookieBytes: 0,
      ...overrides
    })

    await expect(
      verifyHostedWebViewPrivacyIsolation({
        document: { webSocketDebuggerUrl: 'ws://localhost/page' },
        WebSocketCtor: fakeCdpConstructor(socket)
      })
    ).rejects.toThrow('privacy isolation failed')
  })
})

class FakeCdpSocket {
  expression = ''
  private messageListener: ((data: Buffer) => void) | undefined

  constructor(private readonly value: unknown) {}

  once(event: string, listener: () => void): void {
    if (event === 'open') {
      queueMicrotask(listener)
    }
  }

  on(event: string, listener: (data: Buffer) => void): void {
    if (event === 'message') {
      this.messageListener = listener
    }
  }

  send(payload: string): void {
    const request = JSON.parse(payload)
    this.expression = request.params.expression
    queueMicrotask(() => {
      this.messageListener?.(
        Buffer.from(
          JSON.stringify({
            id: 1,
            result: { result: { value: JSON.stringify(this.value) } }
          })
        )
      )
    })
  }

  close(): void {}
}

function fakeCdpConstructor(socket: FakeCdpSocket) {
  return class {
    constructor() {
      return socket
    }
  }
}
