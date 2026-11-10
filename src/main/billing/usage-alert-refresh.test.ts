import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingEntitlement } from '../../shared/orca-billing'
import { notifyUsageAlertIfDue } from './usage-alert-notifier'
import {
  createUsageAlertRefreshScheduler,
  USAGE_ALERT_POLL_MS,
  type UsageAlertRefreshScheduler
} from './usage-alert-refresh'

const HOUR = 3600
const NOV = Date.UTC(2026, 10, 3)
const DEC = Date.UTC(2026, 11, 3)
const BEAT_MS = 30_000

/** `used` hours of 120 included, with billing's warning level. */
const at = (level: number | null, used: number): OrcaBillingEntitlement => ({
  plan: 'team',
  planLabel: 'Team',
  status: 'active',
  interval: 'month',
  seats: 2,
  seatChange: null,
  period: { start: NOV, end: DEC },
  usageWindow: { start: NOV, end: DEC },
  cancelAtPeriodEnd: false,
  includedSeconds: 120 * HOUR,
  usedSeconds: used * HOUR,
  remainingIncludedSeconds: Math.max(0, 120 - used) * HOUR,
  usageWarningPercent: level,
  overageSeconds: 0,
  overage: { optedIn: false, active: false, spendCapCents: 2500, spentCents: 0, centsPerHour: 100 },
  payment: { pastDueSince: null, graceEndsAt: null, suspendRunning: false },
  canStartSandbox: true,
  reason: null,
  canManageBilling: true,
  offers: null
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Orca Cloud's 30 s lifecycle beat reporting `running` for `ms`, as hosted-sandbox-install does. */
function beatFor(scheduler: UsageAlertRefreshScheduler, running: boolean, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += BEAT_MS) {
    vi.advanceTimersByTime(BEAT_MS)
    scheduler.setRunning(running)
  }
}

describe('usage alert refresh scheduler', () => {
  it('re-reads billing at once when a cloud workspace is created or woken', () => {
    const requestRefresh = vi.fn()
    const scheduler = createUsageAlertRefreshScheduler({ requestRefresh })
    scheduler.noteStarted()
    expect(requestRefresh).toHaveBeenCalledTimes(1)
    scheduler.noteStarted()
    expect(requestRefresh).toHaveBeenCalledTimes(2)
  })

  it('re-reads every 30 minutes while a workspace runs, and adds no timer of its own', () => {
    const requestRefresh = vi.fn()
    const scheduler = createUsageAlertRefreshScheduler({ requestRefresh })
    scheduler.setRunning(true)
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS - BEAT_MS)
    expect(requestRefresh).not.toHaveBeenCalled()
    beatFor(scheduler, true, BEAT_MS)
    expect(requestRefresh).toHaveBeenCalledTimes(1)
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS * 2)
    expect(requestRefresh).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a create/wake read pushes the next poll a full interval out', () => {
    const requestRefresh = vi.fn()
    const scheduler = createUsageAlertRefreshScheduler({ requestRefresh })
    scheduler.setRunning(true)
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS / 2)
    scheduler.noteStarted()
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS - BEAT_MS)
    expect(requestRefresh).toHaveBeenCalledTimes(1)
    beatFor(scheduler, true, BEAT_MS)
    expect(requestRefresh).toHaveBeenCalledTimes(2)
  })

  it('never polls while nothing is running', () => {
    const requestRefresh = vi.fn()
    const scheduler = createUsageAlertRefreshScheduler({ requestRefresh })
    beatFor(scheduler, false, USAGE_ALERT_POLL_MS * 4)
    expect(requestRefresh).not.toHaveBeenCalled()
  })

  it('stops when the last workspace stops or sleeps, and restarts when one starts', () => {
    const requestRefresh = vi.fn()
    const scheduler = createUsageAlertRefreshScheduler({ requestRefresh })
    scheduler.setRunning(true)
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS)
    expect(requestRefresh).toHaveBeenCalledTimes(1)
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS - BEAT_MS)
    // The last one sleeps just before the next poll was due.
    beatFor(scheduler, false, USAGE_ALERT_POLL_MS * 3)
    expect(requestRefresh).toHaveBeenCalledTimes(1)
    // One starts again: a full interval from now, not an overdue poll at once.
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS)
    expect(requestRefresh).toHaveBeenCalledTimes(1)
    beatFor(scheduler, true, BEAT_MS)
    expect(requestRefresh).toHaveBeenCalledTimes(2)
    scheduler.dispose()
    beatFor(scheduler, true, USAGE_ALERT_POLL_MS * 3)
    expect(requestRefresh).toHaveBeenCalledTimes(2)
  })

  it('a team crossing a level between polls is notified exactly once', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-usage-refresh-'))
    try {
      // Billing as each read sees it: under 75% at the wake, past it by the first poll, still past.
      const reads = [at(null, 70), at(75, 92), at(75, 95), at(75, 98)]
      const show = vi.fn()
      const pending: Promise<number | null>[] = []
      const scheduler = createUsageAlertRefreshScheduler({
        requestRefresh: () => {
          const entitlement = reads.shift()
          if (entitlement) {
            pending.push(
              notifyUsageAlertIfDue('user-1:org-1', entitlement, {
                userDataPath,
                notificationsEnabled: () => true,
                body: () => 'You have used 75% of your included hours.',
                show
              })
            )
          }
        }
      })
      scheduler.noteStarted()
      scheduler.setRunning(true)
      for (let poll = 0; poll < 3; poll++) {
        beatFor(scheduler, true, USAGE_ALERT_POLL_MS)
        expect(pending).toHaveLength(poll + 2)
        await Promise.all(pending)
      }
      expect(await Promise.all(pending)).toEqual([null, 75, null, null])
      expect(show).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
