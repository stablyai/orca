import { describe, expect, it, vi } from 'vitest'
import { waitForHostedWebViewConnectionSequence } from '../../scripts/hosted-webview-cdp-session.mjs'

describe('hosted WebView CDP target replacement', () => {
  it('reacquires the document while observing reconnect', async () => {
    const recovering = connectionEntry('recovering')
    const connected = connectionEntry('connected')
    const stale = new TargetSocket([
      JSON.stringify([recovering]),
      new Error('target replaced'),
      new Error('target replaced'),
      new Error('target replaced')
    ])
    const replacement = new TargetSocket([JSON.stringify([connected])])
    const WebSocketCtor = class {
      constructor(endpoint: string) {
        return endpoint.endsWith('/stale') ? stale : replacement
      }
    }
    const reacquireDocument = vi.fn().mockResolvedValue({
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/replacement'
    })

    await expect(
      waitForHostedWebViewConnectionSequence(
        { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/stale' },
        ['recovering', 'connected'],
        5_000,
        { WebSocketCtor, reacquireDocument }
      )
    ).resolves.toEqual([recovering, connected])
    expect(reacquireDocument).toHaveBeenCalledOnce()
  })
})

function connectionEntry(state: string) {
  return {
    state,
    href: 'orca-mobile-web://session-a/h/host/agent-history/worktree',
    retainedExpectedText: true,
    retainedExpectedRoute: true
  }
}

class TargetSocket {
  private readonly values: (string | Error)[]
  private errorListener: ((error: Error) => void) | undefined
  private messageListener: ((data: Buffer) => void) | undefined

  constructor(values: (string | Error)[]) {
    this.values = [...values]
  }

  once(event: string, listener: (value?: unknown) => void): void {
    if (event === 'open') {
      queueMicrotask(listener)
    } else if (event === 'error') {
      this.errorListener = listener as (error: Error) => void
    }
  }

  on(event: string, listener: (data: Buffer) => void): void {
    if (event === 'message') {
      this.messageListener = listener
    }
  }

  send(): void {
    const value = this.values.shift() ?? ''
    queueMicrotask(() => {
      if (value instanceof Error) {
        this.errorListener?.(value)
        return
      }
      this.messageListener?.(Buffer.from(JSON.stringify({ id: 1, result: { result: { value } } })))
    })
  }

  close(): void {}
}
