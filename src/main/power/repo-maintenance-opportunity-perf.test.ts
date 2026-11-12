import { afterEach, expect, it, vi } from 'vitest'
import { RepoRefMaintenance } from '../../shared/repo-ref-maintenance'
import { AgentAwakeStatusLease } from './agent-awake-status-lease'

afterEach(() => vi.useRealTimers())

it.each([
  [12, 750, 100, 96, 9600, 1700, 13],
  [120, 7500, 1000, 512, 512000, 17000, 65]
])(
  'bounds retained maintenance work at %i repos and %i worktrees',
  async (repos, worktrees, agents, checks, visits, upkeepBound, timers) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let inEligibility = false
    let eligibilityVisits = 0
    let upkeepVisits = 0
    const lease = new AgentAwakeStatusLease(Date.now, () => {})
    const statuses = Array.from({ length: agents }, (_, index) => ({
      paneKey: String(index),
      state: 'working' as const,
      receivedAt: 0,
      get observedInCurrentRuntime() {
        if (inEligibility) {
          eligibilityVisits += 1
        } else {
          upkeepVisits += 1
        }
        return true
      }
    }))
    lease.replace(statuses)
    const busy = vi.fn(() => {
      inEligibility = true
      try {
        return lease.countEligible() > 0
      } finally {
        inEligibility = false
      }
    })
    const repoBusy = vi.fn(() => false)
    const io = vi.fn()
    const maintenance = new RepoRefMaintenance({ isBusy: busy })
    try {
      for (let index = 0; index < worktrees; index += 1) {
        maintenance.arm({
          key: String(index % repos),
          isBusy: repoBusy,
          isOptedOut: async () => {
            io()
            return false
          },
          resolveRefsDirectory: async () => {
            io()
            return undefined
          },
          maintainPackIndex: async () => {
            io()
          },
          packRefs: async () => {
            io()
          }
        })
      }
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timers)
      // Eight opportunities through minute 470; renew live statuses before each <2h gap.
      for (const minutes of [10, 20, 40, 80, 80, 80, 80, 80]) {
        for (const status of statuses) {
          status.receivedAt = Date.now()
          lease.renew(status)
        }
        await vi.advanceTimersByTimeAsync(minutes * 60_000)
        await maintenance.whenAttemptSettled()
        expect(vi.getTimerCount()).toBeLessThanOrEqual(timers)
      }
      expect(busy).toHaveBeenCalledTimes(checks)
      expect(eligibilityVisits).toBe(visits)
      // Setup + eight renewals + at most one expiry scan per renewed interval.
      expect(upkeepVisits).toBeLessThanOrEqual(upkeepBound)
      expect(repoBusy).not.toHaveBeenCalled()
      expect(io).not.toHaveBeenCalled()
    } finally {
      maintenance.dispose()
      lease.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  }
)
