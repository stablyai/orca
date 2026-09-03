import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketTransport } from './ws-transport'

describe('WebSocketTransport requirePinnedPort', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  it('refuses to move to another port when the pinned one is taken', async () => {
    const occupant = createServer()
    await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => occupant.close(() => resolve())))
    const port = (occupant.address() as AddressInfo).port

    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port,
      fallbackPort: 0,
      requirePinnedPort: true
    })
    cleanups.push(() => transport.stop())
    // Why: every Tailcat link embeds this port; silently binding elsewhere would strand every client.
    await expect(transport.start()).rejects.toThrow(/needs this exact port/)
  })

  it('binds the pinned port normally when it is free', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const transport = new WebSocketTransport({ host: '127.0.0.1', port, requirePinnedPort: true })
    cleanups.push(() => transport.stop())
    await transport.start()
    expect(transport.resolvedPort).toBe(port)
  })
})
