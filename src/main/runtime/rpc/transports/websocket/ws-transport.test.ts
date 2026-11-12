import 'node:events'
import { describe, expect, it, afterEach } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'
import './node-websocket-lifecycle'

describe('WebSocketTransport', () => {
  const transports: WebSocketTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop().catch(() => {})))
    transports.length = 0
  })

  async function createTransport(
    handler?: (msg: string, reply: (response: string) => void) => void,
    options: { preAuthTimeoutMs?: number } = {}
  ) {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      // Port 0 reserves atomically; probed free ports can race.
      port: 0,
      preAuthTimeoutMs: options.preAuthTimeoutMs
    })
    if (handler) {
      transport.onMessage(handler)
    }
    transports.push(transport)
    return { transport }
  }

  function connectWs(target: number | WebSocketTransport): Promise<WebSocket> {
    const port = typeof target === 'number' ? target : target.resolvedPort
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  it('falls back to OS-assigned port when preferred port is in use', async () => {
    const { transport: first } = await createTransport()
    await first.start()
    const occupiedPort = first.resolvedPort

    // A conflicting port must fall back rather than fail startup.
    const second = new WebSocketTransport({
      host: '127.0.0.1',
      port: occupiedPort
    })
    transports.push(second)

    await second.start()

    expect(second.resolvedPort).not.toBe(occupiedPort)
    expect(second.resolvedPort).toBeGreaterThan(0)

    const ws = await connectWs(second.resolvedPort)
    ws.close()
  })

  // Persist fallback endpoints so paired phones remain reachable across restarts (STA-1511).
  describe('fallback port stability', () => {
    async function reserveFreePort(): Promise<number> {
      const scratch = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      await scratch.start()
      const port = scratch.resolvedPort
      await scratch.stop()
      return port
    }

    it('binds the persisted fallback port even when the preferred port is free', async () => {
      // Fallback pairings must survive even when the preferred port becomes free (STA-1511).
      const preferredPort = await reserveFreePort()
      const fallbackPort = await reserveFreePort()

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: preferredPort,
        fallbackPort
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).toBe(fallbackPort)
    })

    it('binds the preferred port first when preferPinnedPort is set and both are free', async () => {
      // An explicit serve --port pin must precede stale persisted fallback (#8535).
      const preferredPort = await reserveFreePort()
      const fallbackPort = await reserveFreePort()

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: preferredPort,
        fallbackPort,
        preferPinnedPort: true
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).toBe(preferredPort)
    })
  })
})
