import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isKeepaliveSuppressed, startCheckKeepalive } from './check-keepalive'

describe('check-keepalive', () => {
  const originalNoKeepalive = process.env.ORCA_NO_KEEPALIVE
  const originalInterval = process.env.ORCA_KEEPALIVE_INTERVAL_MS
  const originalHeartbeat = process.env.ORCA_HEARTBEAT_INTERVAL_MS

  beforeEach(() => {
    delete process.env.ORCA_NO_KEEPALIVE
    delete process.env.ORCA_KEEPALIVE_INTERVAL_MS
    delete process.env.ORCA_HEARTBEAT_INTERVAL_MS
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalNoKeepalive !== undefined) {
      process.env.ORCA_NO_KEEPALIVE = originalNoKeepalive
    } else {
      delete process.env.ORCA_NO_KEEPALIVE
    }
    if (originalInterval !== undefined) {
      process.env.ORCA_KEEPALIVE_INTERVAL_MS = originalInterval
    } else {
      delete process.env.ORCA_KEEPALIVE_INTERVAL_MS
    }
    if (originalHeartbeat !== undefined) {
      process.env.ORCA_HEARTBEAT_INTERVAL_MS = originalHeartbeat
    } else {
      delete process.env.ORCA_HEARTBEAT_INTERVAL_MS
    }
  })

  describe('isKeepaliveSuppressed', () => {
    it('returns false by default when no suppression env vars are set', () => {
      expect(isKeepaliveSuppressed()).toBe(false)
    })

    it('returns true when ORCA_NO_KEEPALIVE is set to true or 1', () => {
      process.env.ORCA_NO_KEEPALIVE = 'true'
      expect(isKeepaliveSuppressed()).toBe(true)

      process.env.ORCA_NO_KEEPALIVE = '1'
      expect(isKeepaliveSuppressed()).toBe(true)
    })

    it('returns true when ORCA_KEEPALIVE_INTERVAL_MS is set to 0, false, or off', () => {
      process.env.ORCA_KEEPALIVE_INTERVAL_MS = '0'
      expect(isKeepaliveSuppressed()).toBe(true)

      process.env.ORCA_KEEPALIVE_INTERVAL_MS = 'false'
      expect(isKeepaliveSuppressed()).toBe(true)

      process.env.ORCA_KEEPALIVE_INTERVAL_MS = 'off'
      expect(isKeepaliveSuppressed()).toBe(true)
    })

    it('returns true when legacy ORCA_HEARTBEAT_INTERVAL_MS is set to 0', () => {
      process.env.ORCA_HEARTBEAT_INTERVAL_MS = '0'
      expect(isKeepaliveSuppressed()).toBe(true)
    })
  })

  describe('startCheckKeepalive', () => {
    it('does not write to stderr or start timer when enabled is false', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const stop = startCheckKeepalive(30_000, { enabled: false })

      vi.advanceTimersByTime(30_000)

      expect(stderrSpy).not.toHaveBeenCalled()
      stop()
    })

    it('does not write to stderr when ORCA_NO_KEEPALIVE is set', () => {
      process.env.ORCA_NO_KEEPALIVE = 'true'
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const stop = startCheckKeepalive(30_000)

      vi.advanceTimersByTime(30_000)

      expect(stderrSpy).not.toHaveBeenCalled()
      stop()
    })

    it('emits keepalive frames to stderr when enabled and timer advances', () => {
      process.env.ORCA_KEEPALIVE_INTERVAL_MS = '1000'
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const stop = startCheckKeepalive(10_000)

      vi.advanceTimersByTime(1000)
      expect(stderrSpy).toHaveBeenCalledTimes(1)

      const payload = JSON.parse(String(stderrSpy.mock.calls[0][0]))
      expect(payload._keepalive).toBe(true)
      expect(payload._heartbeat).toBe(true)
      expect(payload.deadlineMs).toBe(10_000)

      vi.advanceTimersByTime(1000)
      expect(stderrSpy).toHaveBeenCalledTimes(2)

      stop()
      vi.advanceTimersByTime(1000)
      expect(stderrSpy).toHaveBeenCalledTimes(2)
    })
  })
})
