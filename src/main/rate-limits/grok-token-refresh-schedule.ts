import type { GrokAuthReadResult } from './grok-auth'
import { grokAccessTokenRefreshDelayMs } from './grok-auth-expiry'

// Node clamps delays above this to 1ms, which would run the CLI immediately.
const MAX_TIMER_MS = 2_147_483_647
const RETRY_MS = 60_000
const MAX_RETRIES = 3

type GrokTokenRefreshSchedule = {
  onDue: () => void
  timer: ReturnType<typeof setTimeout> | null
  retriesFor: number | null
  retries: number
}

let schedule: GrokTokenRefreshSchedule | null = null

export function bindGrokTokenRefreshSchedule(onDue: () => void): void {
  clearGrokTokenRefreshSchedule()
  schedule = { onDue, timer: null, retriesFor: null, retries: 0 }
}

export function clearGrokTokenRefreshSchedule(): void {
  if (schedule?.timer) {
    clearTimeout(schedule.timer)
  }
  schedule = null
}

export function noteGrokAuthForScheduledRefresh(
  read: GrokAuthReadResult,
  afterAttempt: boolean
): void {
  if (!schedule) {
    return
  }
  clearTimer()
  if (read.status !== 'ok') {
    return
  }
  const expiresAtMs = read.session.expiresAtMs
  const delay = grokAccessTokenRefreshDelayMs(expiresAtMs, Date.now())
  if (delay === null) {
    return
  }
  if (delay <= 0) {
    if (!afterAttempt) {
      arm(0, fire)
      return
    }
    if (expiresAtMs !== schedule.retriesFor) {
      schedule.retriesFor = expiresAtMs
      schedule.retries = 0
    }
    if (schedule.retries >= MAX_RETRIES) {
      return
    }
    schedule.retries += 1
    arm(RETRY_MS, fire)
    return
  }
  schedule.retriesFor = null
  schedule.retries = 0
  const wait = Math.min(delay, MAX_TIMER_MS)
  arm(wait, () => {
    const remaining = grokAccessTokenRefreshDelayMs(expiresAtMs, Date.now())
    if (remaining === null || !schedule) {
      return
    }
    if (remaining > 0) {
      noteGrokAuthForScheduledRefresh(read, false)
      return
    }
    fire()
  })
}

function clearTimer(): void {
  if (schedule?.timer) {
    clearTimeout(schedule.timer)
    schedule.timer = null
  }
}

function arm(ms: number, fn: () => void): void {
  if (!schedule) {
    return
  }
  const timer = setTimeout(() => {
    if (!schedule || schedule.timer !== timer) {
      return
    }
    schedule.timer = null
    fn()
  }, ms)
  timer.unref?.()
  schedule.timer = timer
}

function fire(): void {
  schedule?.onDue()
}
