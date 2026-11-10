import { afterEach, describe, expect, it, vi } from 'vitest'

import { RelayControlLiveness } from './relay-control-liveness'

describe('RelayControlLiveness keepalive', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function liveness(live = { value: true }) {
    const terminate = vi.fn()
    // The relay's ack is an inbound frame.
    const sendKeepalive = vi.fn((frame: string) => {
      expect(frame).toBe('{"type":"keepalive"}')
      instance.noteInbound()
    })
    const instance: RelayControlLiveness = new RelayControlLiveness({
      cellUrl: 'https://relay.test',
      ping: vi.fn(),
      isLive: () => live.value,
      terminate,
      send: sendKeepalive
    })
    return { instance, sendKeepalive, terminate, live }
  }

  it('sends a keepalive instead of tearing down when its own timers were held back', () => {
    vi.useFakeTimers()
    const terminate = vi.fn()
    const send = vi.fn()
    const instance = new RelayControlLiveness({
      cellUrl: 'https://relay.test',
      ping: vi.fn(),
      isLive: () => true,
      terminate,
      send
    })
    instance.start()
    instance.startKeepalive(25_000)
    // A throttled app: no timer ran for 100 s, then the silence check runs before the keepalive.
    vi.setSystemTime(Date.now() + 100_000)
    vi.advanceTimersToNextTimer()
    expect(terminate).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('{"type":"keepalive"}')
    // Still unanswered at a later check: the link is judged dead as before.
    vi.advanceTimersByTime(80_000)
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('ignores an offer before the control is active and stops with the control', () => {
    vi.useFakeTimers()
    const { instance, sendKeepalive } = liveness()
    instance.startKeepalive(25_000)
    vi.advanceTimersByTime(50_000)
    expect(sendKeepalive).not.toHaveBeenCalled()
    instance.start()
    instance.startKeepalive(25_000)
    instance.stop()
    vi.advanceTimersByTime(100_000)
    expect(sendKeepalive).not.toHaveBeenCalled()
  })
})
