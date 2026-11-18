import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayControlLiveness } from './relay-control-liveness'

function harness(options: { onStall?: () => void; random?: () => number } = {}) {
  const ping = vi.fn()
  const terminate = vi.fn()
  const liveness = new RelayControlLiveness({
    cellUrl: 'https://relay.example.test',
    ping,
    send: vi.fn(),
    isLive: () => true,
    terminate,
    random: options.random ?? (() => 0.5),
    ...(options.onStall ? { onStall: options.onStall } : {})
  })
  return { liveness, ping, terminate }
}

describe('RelayControlLiveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('without an alternate path (stall detector off)', () => {
    it('sends no pings and keeps the 75s silence bound, checked every 15s', async () => {
      const { liveness, ping, terminate } = harness()
      liveness.start()

      await vi.advanceTimersByTimeAsync(89_999)
      expect(terminate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(terminate).toHaveBeenCalledOnce()
      expect(ping).not.toHaveBeenCalled()
    })

    it('stays up on relay traffic alone and never pings', async () => {
      const { liveness, ping, terminate } = harness()
      liveness.start()
      for (let elapsed = 0; elapsed < 300_000; elapsed += 25_000) {
        await vi.advanceTimersByTimeAsync(25_000)
        liveness.noteInbound()
      }
      expect(ping).not.toHaveBeenCalled()
      expect(terminate).not.toHaveBeenCalled()
      liveness.stop()
    })
  })

  describe('with an alternate path (stall detector on)', () => {
    it('reports a dark path once, after two unanswered pings and 30s of silence', async () => {
      const onStall = vi.fn()
      const { liveness, ping, terminate } = harness({ onStall })
      liveness.start()

      await vi.advanceTimersByTimeAsync(29_999)
      expect(onStall).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onStall).toHaveBeenCalledOnce()
      // The pings at 10s and 20s went unanswered.
      expect(ping).toHaveBeenCalledTimes(2)
      // The detector only reports; the caller decides. The legacy bound still owns teardown.
      expect(terminate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onStall).toHaveBeenCalledOnce()
      expect(terminate).toHaveBeenCalledOnce()
    })

    it('detects within 36s at any ping jitter', async () => {
      for (const random of [0, 0.999]) {
        const onStall = vi.fn()
        const { liveness } = harness({ onStall, random: () => random })
        liveness.start()
        await vi.advanceTimersByTimeAsync(36_000)
        expect(onStall).toHaveBeenCalledOnce()
        liveness.stop()
      }
    })

    it('never reports while pings are answered', async () => {
      const onStall = vi.fn()
      const { liveness, ping } = harness({ onStall })
      ping.mockImplementation(() => liveness.notePong())
      liveness.start()
      await vi.advanceTimersByTimeAsync(70_000)
      expect(ping.mock.calls.length).toBeGreaterThanOrEqual(6)
      expect(onStall).not.toHaveBeenCalled()
      liveness.stop()
    })

    it('never reports when pongs are dropped but the 25s edge ping still arrives', async () => {
      const onStall = vi.fn()
      const { liveness } = harness({ onStall })
      liveness.start()
      for (let elapsed = 0; elapsed < 300_000; elapsed += 25_000) {
        await vi.advanceTimersByTimeAsync(25_000)
        liveness.noteInbound()
      }
      expect(onStall).not.toHaveBeenCalled()
      liveness.stop()
    })

    it('treats one lost pong as inconclusive', async () => {
      const onStall = vi.fn()
      const { liveness, ping } = harness({ onStall })
      let calls = 0
      ping.mockImplementation(() => {
        calls += 1
        if (calls !== 2) {
          liveness.notePong()
        }
      })
      liveness.start()
      await vi.advanceTimersByTimeAsync(70_000)
      expect(onStall).not.toHaveBeenCalled()
      liveness.stop()
    })

    it('stops with the control', async () => {
      const onStall = vi.fn()
      const { liveness, ping } = harness({ onStall })
      liveness.start()
      liveness.stop()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(ping).not.toHaveBeenCalled()
      expect(onStall).not.toHaveBeenCalled()
    })
  })
})
