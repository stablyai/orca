import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayControlLiveness } from './relay-control-liveness'

const KEEPALIVE_INTERVAL_MS = 30_000

function keepaliveControl() {
  const ping = vi.fn()
  const send = vi.fn()
  const terminate = vi.fn()
  const liveness = new RelayControlLiveness({
    cellUrl: 'https://relay-c1.example',
    ping,
    send,
    isLive: () => terminate.mock.calls.length === 0,
    terminate,
    random: () => 0.5
  })
  liveness.start()
  liveness.startKeepalive(KEEPALIVE_INTERVAL_MS)
  return { liveness, ping, send, terminate }
}

describe('RelayControlLiveness keepalive acks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never probes a control whose keepalives are answered', async () => {
    const { liveness, send, ping, terminate } = keepaliveControl()
    // The edge answers each keepalive within a round trip.
    send.mockImplementation(() => setTimeout(() => liveness.noteInbound(), 300))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(19)
    expect(ping).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
    liveness.stop()
  })

  it('probes once a reply is 10s overdue and tears down after three unanswered pings', async () => {
    const { liveness, ping, terminate } = keepaliveControl()
    // Blackhole from the start: the first keepalive goes out at 30s.
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 9_999)
    expect(ping).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ping).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[relay\] control keepalive overdue cell=\S+ sinceInboundMs=40000 probe=armed$/
      )
    )
    // Three 8s probe intervals: torn down at 64s, well before the 75s silence bound.
    await vi.advanceTimersByTimeAsync(24_000)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[relay] control torn down cell=https://relay-c1.example reason=probe-unanswered'
    )
    liveness.stop()
  })

  it('keeps a control whose one lost ack is followed by a pong', async () => {
    const { liveness, send, ping, terminate } = keepaliveControl()
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10_000)
    expect(ping).toHaveBeenCalledTimes(1)
    liveness.notePong()
    // Later keepalives are answered again.
    send.mockImplementation(() => setTimeout(() => liveness.noteInbound(), 300))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(ping).toHaveBeenCalledTimes(1)
    expect(terminate).not.toHaveBeenCalled()
    liveness.stop()
  })

  it('does not watch acks on relays that never offered keepalive', async () => {
    const ping = vi.fn()
    const terminate = vi.fn()
    const liveness = new RelayControlLiveness({
      cellUrl: 'https://relay-c1.example',
      ping,
      isLive: () => true,
      terminate
    })
    liveness.start()
    // Relay pings arrive every 15s as before.
    const relayPing = setInterval(() => liveness.noteInbound(), 15_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    clearInterval(relayPing)
    expect(ping).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
    liveness.stop()
  })
})
