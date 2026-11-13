import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CloudRelayTransport } from './relay-transport'

class FakeDataSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = 0
  send = vi.fn()
  terminate = vi.fn(() => this.closeWith(1006))

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

function setup() {
  const sockets: FakeDataSocket[] = []
  const outcomes: boolean[] = []
  const transport = new CloudRelayTransport({
    cellUrl: 'https://relay-c1.example',
    relayHostId: 'host',
    generation: 1,
    createSocket: () => {
      const socket = new FakeDataSocket()
      sockets.push(socket)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every socket member openConnection and stop use.
      return socket as unknown as WebSocket
    },
    onAttachSettled: (attached) => outcomes.push(attached)
  })
  let next = 0
  const open = () =>
    transport.openConnection({
      connId: `conn-${++next}`,
      connTicket: 'A'.repeat(43),
      kind: 'resume',
      relayDeviceId: 'device',
      attachDeadlineMs: 10_000
    })
  return { transport, sockets, outcomes, open }
}

describe('CloudRelayTransport attach outcome', () => {
  afterEach(() => vi.useRealTimers())

  it('reports success on the first relay frame and nothing more', async () => {
    const { sockets, outcomes, open } = setup()
    const opening = open()
    sockets[0].open()
    await opening
    sockets[0].emit('message', Buffer.from('{}'), false)
    sockets[0].emit('message', Buffer.from('{}'), false)
    sockets[0].closeWith(4404)
    expect(outcomes).toEqual([true])
  })

  it('reports a failure for a missed deadline, an error before open and a 4xxx refusal', async () => {
    vi.useFakeTimers()
    const { sockets, outcomes, open } = setup()

    // Opened but never attached: the deadline is the phone's attach-timeout.
    const opened = open()
    sockets[0].open()
    await opened
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outcomes).toEqual([false])

    const errored = open()
    sockets[1].emit('error', new Error('ECONNRESET'))
    await expect(errored).rejects.toThrow('ECONNRESET')
    expect(outcomes).toEqual([false, false])

    const refused = open()
    sockets[2].open()
    await refused
    sockets[2].closeWith(4401)
    expect(outcomes).toEqual([false, false, false])
  })

  it('does not count ordinary closes after open as attach failures', async () => {
    vi.useFakeTimers()
    const { transport, sockets, outcomes, open } = setup()
    const first = open()
    sockets[0].open()
    await first
    sockets[0].closeWith(1006)

    const second = open()
    sockets[1].open()
    await second
    await transport.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outcomes).toEqual([])
  })
})
