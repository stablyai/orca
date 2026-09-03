import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeKeepAliveFrame, KEEPALIVE_SEND_MS, TIMEOUT_MS } from './relay-protocol'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'

type WedgedTransport = MultiplexerTransport & { writes: Buffer[]; feed: (chunk: Buffer) => void }

/**
 * A transport that accepts the first write, then reports backpressure forever: no drain, and no
 * write settlement. This is a half-open TCP link — the socket buffer filled and the peer's FIN
 * never arrived — which is what sleep/resume and a dropped NAT mapping produce in the field.
 */
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
    // Drive well past every health window: keepalive interval, dead-link timeout, and the
    // wake-gap grace that resets staleness after a suspend.
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
    // The regression guard for the fix above: backpressure on our uplink is not evidence of
    // death, and the relay's own keepalive is what proves it.
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
