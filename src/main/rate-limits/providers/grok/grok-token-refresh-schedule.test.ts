import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GrokAuthReadResult } from './grok-auth'
import { GROK_ACCESS_TOKEN_REFRESH_LEAD_MS } from './grok-auth-expiry'
import {
  bindGrokTokenRefreshSchedule,
  clearGrokTokenRefreshSchedule,
  noteGrokAuthForScheduledRefresh
} from './grok-token-refresh-schedule'

function session(expiresAtMs: number | null): GrokAuthReadResult {
  return {
    status: 'ok',
    session: {
      accessToken: 'token',
      userId: null,
      email: null,
      teamId: null,
      expiresAtMs,
      oidcClientId: null
    }
  }
}

describe('grok token refresh schedule', () => {
  afterEach(() => {
    clearGrokTokenRefreshSchedule()
    vi.useRealTimers()
  })

  it('fires once the lead window opens', () => {
    vi.useFakeTimers()
    const onDue = vi.fn()
    bindGrokTokenRefreshSchedule(onDue)
    noteGrokAuthForScheduledRefresh(
      session(Date.now() + GROK_ACCESS_TOKEN_REFRESH_LEAD_MS + 5_000),
      false
    )

    vi.advanceTimersByTime(4_999)
    expect(onDue).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onDue).toHaveBeenCalledTimes(1)
  })

  it('checks immediately when the token is already inside the lead window', () => {
    vi.useFakeTimers()
    const onDue = vi.fn()
    bindGrokTokenRefreshSchedule(onDue)
    noteGrokAuthForScheduledRefresh(session(Date.now() + 60_000), false)

    vi.advanceTimersByTime(0)
    expect(onDue).toHaveBeenCalledTimes(1)
  })

  it('retries a failed refresh and then stops for that expiry', () => {
    vi.useFakeTimers()
    const onDue = vi.fn()
    bindGrokTokenRefreshSchedule(onDue)
    const read = session(Date.now() + 60_000)
    noteGrokAuthForScheduledRefresh(read, true)
    vi.advanceTimersByTime(60_000)
    noteGrokAuthForScheduledRefresh(read, true)
    vi.advanceTimersByTime(60_000)
    noteGrokAuthForScheduledRefresh(read, true)
    vi.advanceTimersByTime(60_000)
    noteGrokAuthForScheduledRefresh(read, true)
    vi.advanceTimersByTime(60_000)

    expect(onDue).toHaveBeenCalledTimes(3)
  })

  it('does not arm a timer when no schedule is bound', () => {
    vi.useFakeTimers()
    noteGrokAuthForScheduledRefresh(session(Date.now() + 1_000), false)
    vi.advanceTimersByTime(5_000)
  })

  it('drops the timer when auth is missing', () => {
    vi.useFakeTimers()
    const onDue = vi.fn()
    bindGrokTokenRefreshSchedule(onDue)
    noteGrokAuthForScheduledRefresh(
      session(Date.now() + GROK_ACCESS_TOKEN_REFRESH_LEAD_MS + 5_000),
      false
    )
    noteGrokAuthForScheduledRefresh({ status: 'missing' }, false)
    vi.advanceTimersByTime(5_000)
    expect(onDue).not.toHaveBeenCalled()
  })
})
