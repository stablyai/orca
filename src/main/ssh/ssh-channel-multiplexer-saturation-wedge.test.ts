import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeKeepAliveFrame,
  KEEPALIVE_SEND_MS,
  TIMEOUT_MS
} from './remote-exec/remote-frame-protocol'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'

type WedgedTransport = MultiplexerTransport & { writes: Buffer[]; feed: (chunk: Buffer) => void }

/** Model a half-open link: one accepted write then permanent backpressure with neither drain nor settlement. */
function createWedgedTransport(): WedgedTransport {
  const writes: Buffer[] = []
  let onData: (chunk: Buffer) => void = () => {}
  return {
    write: (data) => {
      writes.push(data)
      return false
    },
    onData: (callback) => {
      onData = callback
    },
    onClose: () => {},
    onDrain: () => () => {},
    supportsWriteSettlement: true,
    writes,
    feed: (chunk) => onData(chunk)
  }
}

describe('SshChannelMultiplexer on a transport that saturates and never drains', () => {
  let transport: WedgedTransport
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    transport = createWedgedTransport()
    mux = new SshChannelMultiplexer(transport)
  })

  afterEach(() => {
    mux.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('declares the link lost instead of suppressing the dead-link check forever', async () => {
    // Exceed keepalive, dead-link and wake-gap health windows.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10 + KEEPALIVE_SEND_MS)

    expect(mux.isDisposed()).toBe(true)
  })

  it('fails a request parked behind saturation rather than leaving it pending forever', async () => {
    const settled = vi.fn()
    mux.request('pty.spawn', {}).then(
      () => settled('resolved'),
      () => settled('rejected')
    )

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10 + KEEPALIVE_SEND_MS)

    expect(settled).toHaveBeenCalledWith('rejected')
  })

  it('keeps a slow-but-alive peer connected while its own keepalives arrive', async () => {
    // Outbound saturation proves nothing; inbound keepalives alone must preserve a slow live peer.
    let seq = 1
    const inbound = setInterval(() => {
      transport.feed(encodeKeepAliveFrame(seq++, 0))
    }, KEEPALIVE_SEND_MS)
    try {
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10 + KEEPALIVE_SEND_MS)
      expect(mux.isDisposed()).toBe(false)
    } finally {
      clearInterval(inbound)
    }
  })
})
