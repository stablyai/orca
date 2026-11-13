import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayControlOrigin } from './relay-control-origin'
import type { RelayControlOriginOptions } from './relay-control-origin-options'
import type { RelayConnectionOpenMessage } from '../control-channel/relay-control-protocol'

class SilentDataSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = 0
  send = vi.fn()
  terminate = vi.fn(() => {
    this.readyState = this.CLOSED
    this.emit('close', 1006)
  })
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

describe('RelayControlOrigin data-attach health', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function originWithSilentDataPath(onDrain: RelayControlOriginOptions['onDrain']) {
    // Only the data path runs here; control, identity and wiring members are never read.
    const options = {
      assignment: { v: 1, cellUrl: 'https://relay-c1.example', assignmentEpoch: 1, lease: 'l' },
      mobileSocketWiring: { attachTransport: () => () => {} },
      createDataSocket: () => new SilentDataSocket(),
      onConnectionOwned: vi.fn(),
      onConnectionReleased: vi.fn(),
      onDrain,
      onClose: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the data path reads only the members above; the fake socket implements what CloudRelayTransport uses.
    const origin = new RelayControlOrigin(options as unknown as RelayControlOriginOptions)
    // conn-open normally arrives over the seated control; drive the same handler directly.
    const open = (message: RelayConnectionOpenMessage): void => origin['openConnection'](message)
    return { origin, open }
  }

  it('drains to the director after phones twice miss the attach deadline', async () => {
    const onDrain = vi.fn()
    const { origin, open } = originWithSilentDataPath(onDrain)
    await origin.transport.start()

    open(conn('conn-1'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDrain).not.toHaveBeenCalled()

    open(conn('conn-2'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDrain).toHaveBeenCalledWith(origin, {
      type: 'drain',
      graceMs: 0,
      recovery: 'resolve-director'
    })
    await origin.close()
  })

  it('does not count sockets its own close tore down mid-attach', async () => {
    const onDrain = vi.fn()
    const { origin, open } = originWithSilentDataPath(onDrain)
    await origin.transport.start()
    open(conn('conn-1'))
    open(conn('conn-2'))
    await origin.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDrain).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })
})
