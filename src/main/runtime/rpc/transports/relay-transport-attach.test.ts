import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CloudRelayTransport } from './relay-transport'

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

function setup() {
  const sockets: FakeDataSocket[] = []
  const outcomes: [string, number | null, boolean][] = []
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
    onDataDialSettled: (connectionId, openedAfterMs, attached) =>
      outcomes.push([connectionId, openedAfterMs, attached])
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

describe('CloudRelayTransport data dial outcome', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports a dial that never opened once: deadline or socket error', async () => {
    const { sockets, outcomes, open } = setup()
    const timedOut = open()
    const timeoutSettled = expect(timedOut).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10_000)
    await timeoutSettled

    const errored = open()
    sockets[1].emit('error', new Error('ECONNRESET'))
    await expect(errored).rejects.toThrow('ECONNRESET')
    expect(outcomes).toEqual([
      ['conn-1', null, false],
      ['conn-2', null, false]
    ])
  })

  it('reports an open that ended before the first frame, whatever ended it', async () => {
    const { sockets, outcomes, open } = setup()
    // 4401 (phone left, or the relay's first-frame timeout), 4408 (phone dropped), or a quiet
    // phone until the attach deadline: the owner weighs these by how late the dial opened.
    for (const ending of [
      (socket: FakeDataSocket) => socket.closeWith(4401),
      (socket: FakeDataSocket) => socket.closeWith(4408),
      () => vi.advanceTimersByTimeAsync(10_000)
    ]) {
      const opening = open()
      const socket = sockets.at(-1)!
      socket.open()
      await opening
      await ending(socket)
    }
    expect(outcomes).toEqual([
      ['conn-1', 0, false],
      ['conn-2', 0, false],
      ['conn-3', 0, false]
    ])
  })

  it('reports the open latency and the first frame once', async () => {
    const { sockets, outcomes, open } = setup()
    const opening = open()
    await vi.advanceTimersByTimeAsync(7_000)
    sockets[0].open()
    await opening
    sockets[0].emit('message', Buffer.from('{}'), false)
    sockets[0].emit('message', Buffer.from('{}'), false)
    sockets[0].closeWith(1000)
    expect(outcomes).toEqual([['conn-1', 7_000, true]])
  })
})
