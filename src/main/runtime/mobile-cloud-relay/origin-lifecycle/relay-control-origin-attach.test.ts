import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayControlOrigin } from './relay-control-origin'
import type { RelayControlOriginOptions } from './relay-control-origin-options'
import type { RelayConnectionOpenMessage } from '../control-channel/relay-control-protocol'

class FakeDataSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = 0
  send = vi.fn()
  // Like ws: terminating a connecting socket emits error, then close.
  terminate = vi.fn(() => {
    if (this.readyState === 0) {
      this.emit('error', new Error('closed before the connection was established'))
    }
    this.closeWith(1006)
  })

  open(): void {
    this.readyState = this.OPEN
    this.emit('open')
  }

  closeWith(code: number): void {
    if (this.readyState !== this.CLOSED) {
      this.readyState = this.CLOSED
      this.emit('close', code)
    }
  }
}

function conn(connId: string): RelayConnectionOpenMessage {
  return {
    type: 'conn-open',
    connId,
    connTicket: 'A'.repeat(43),
    kind: 'resume',
    relayDeviceId: 'device',
    attachDeadlineMs: 10_000
  }
}

describe('RelayControlOrigin data-path health', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function originWithDataPath() {
    const sockets: FakeDataSocket[] = []
    const onDataPathUnhealthy = vi.fn()
    // Only the data path runs here; control, identity and wiring members are never read.
    const options = {
      assignment: { v: 1, cellUrl: 'https://relay-c1.example', assignmentEpoch: 1, lease: 'l' },
      mobileSocketWiring: { attachTransport: () => () => {} },
      createDataSocket: () => {
        const socket = new FakeDataSocket()
        sockets.push(socket)
        return socket
      },
      onConnectionOwned: vi.fn(),
      onConnectionReleased: vi.fn(),
      onDrain: vi.fn(),
      onDataPathUnhealthy,
      onClose: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the data path reads only the members above; the fake socket implements what CloudRelayTransport uses.
    const origin = new RelayControlOrigin(options as unknown as RelayControlOriginOptions)
    await origin.transport.start()
    // conn-open normally arrives over the seated control; drive the same handler directly.
    const open = (connId: string): FakeDataSocket => {
      origin['openConnection'](conn(connId))
      return sockets.at(-1)!
    }
    return { origin, open, onDataPathUnhealthy }
  }

  it('reports when this host cannot open dials for two phones', async () => {
    const { origin, open, onDataPathUnhealthy } = await originWithDataPath()
    open('conn-1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDataPathUnhealthy).not.toHaveBeenCalled()

    open('conn-2').emit('error', new Error('ETIMEDOUT'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onDataPathUnhealthy).toHaveBeenCalledWith(origin)
    await origin.close()
  })

  it('ignores phones that leave, drop or go quiet after the host dial opened', async () => {
    const { origin, open, onDataPathUnhealthy } = await originWithDataPath()
    // Two quick foreground/background cycles on the phone, then a phone that never speaks.
    for (const [connId, code] of [
      ['conn-1', 4401],
      ['conn-2', 4408],
      ['conn-3', 4401],
      ['conn-4', 4408]
    ] as const) {
      const socket = open(connId)
      socket.open()
      socket.closeWith(code)
    }
    open('conn-5').open()
    open('conn-6').open()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDataPathUnhealthy).not.toHaveBeenCalled()
    await origin.close()
  })

  it('reports dials that open too late for the relay window, then see the 4401', async () => {
    const { origin, open, onDataPathUnhealthy } = await originWithDataPath()
    // conn-open reached us late and the dial opened at 7s: host-data-auth misses the relay's
    // window, the phone gets 4404 attach-timeout and the relay closes 4401 first-frame timeout.
    for (const connId of ['conn-1', 'conn-2']) {
      const socket = open(connId)
      await vi.advanceTimersByTimeAsync(7_000)
      socket.open()
      socket.closeWith(4401)
    }
    expect(onDataPathUnhealthy).toHaveBeenCalledWith(origin)
    await origin.close()
  })

  it('lets a fast open clear a slow one', async () => {
    const { origin, open, onDataPathUnhealthy } = await originWithDataPath()
    for (const [connId, openAfterMs] of [
      ['conn-1', 7_000],
      ['conn-2', 500],
      ['conn-3', 7_000]
    ] as const) {
      const socket = open(connId)
      await vi.advanceTimersByTimeAsync(openAfterMs)
      socket.open()
      socket.closeWith(4401)
    }
    expect(onDataPathUnhealthy).not.toHaveBeenCalled()
    await origin.close()
  })

  it('does not count dials its own close tore down', async () => {
    const { origin, open, onDataPathUnhealthy } = await originWithDataPath()
    open('conn-1')
    open('conn-2')
    await origin.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDataPathUnhealthy).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })
})
