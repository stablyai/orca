import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingEntitlement } from '../../shared/orca-billing'
import {
  decideUsageAlert,
  usageAlertLevel,
  usageAlertSentence
} from '../../shared/orca-billing-usage-alerts'
import {
  notifyUsageAlertIfDue,
  readUsageAlertLedger,
  USAGE_ALERT_TITLE,
  type UsageAlertDeps
} from './usage-alert-notifier'

const HOUR = 3600
const NOV = Date.UTC(2026, 10, 3)
const DEC = Date.UTC(2026, 11, 3)
const JAN = Date.UTC(2027, 0, 3)

const team = (patch: Partial<OrcaBillingEntitlement> = {}): OrcaBillingEntitlement => ({
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
  usedSeconds: 41.5 * HOUR,
  remainingIncludedSeconds: 78.5 * HOUR,
  usageWarningPercent: null,
  overageSeconds: 0,
  overage: { optedIn: false, active: false, spendCapCents: 2500, spentCents: 0, centsPerHour: 100 },
  payment: { pastDueSince: null, graceEndsAt: null, suspendRunning: false },
  canStartSandbox: true,
  reason: null,
  canManageBilling: true,
  offers: {
    team: {
      label: 'Team',
      monthlyPriceLabel: '',
      annualPriceLabel: '',
      monthlyPriceCentsPerSeat: null,
      annualPriceCentsPerSeat: null,
      largeMachineWeight: 1,
      includedHoursPerSeat: 60,
      concurrentSandboxesPerSeat: 3,
      idleSleepMinutes: 15,
      overageCentsPerHour: 100,
      defaultSpendCapCents: 2500,
      maxSpendCapCents: null,
      warnAtPercent: [75, 90, 100]
    },
    enterprise: { label: 'Enterprise', priceLabel: '', contactUrl: 'https://example.test' }
  },
  ...patch
})

/** `used` hours of 120, with billing's level. */
const at = (
  level: number | null,
  used: number,
  patch: Partial<OrcaBillingEntitlement> = {}
): OrcaBillingEntitlement =>
  team({
    usedSeconds: used * HOUR,
    remainingIncludedSeconds: Math.max(0, 120 - used) * HOUR,
    usageWarningPercent: level,
    ...patch
  })
const nextMonth = { period: { start: DEC, end: JAN }, usageWindow: { start: DEC, end: JAN } }

describe('decideUsageAlert', () => {
  it('does nothing below 75%', () => {
    expect(decideUsageAlert({}, 'u:o', at(null, 80)).notify).toBeNull()
    expect(usageAlertLevel(at(null, 89))).toBeNull()
  })

  it('never alerts members', () => {
    const decision = decideUsageAlert({}, 'u:o', at(90, 110, { canManageBilling: false }))
    expect(decision.notify).toBeNull()
    expect(decision.ledger).toEqual({})
  })

  it('alerts once per level with the floored percent used', () => {
    const first = decideUsageAlert({}, 'u:o', at(75, 92))
    expect(first.notify).toEqual({ level: 75, percent: 76 })
    expect(decideUsageAlert(first.ledger, 'u:o', at(75, 95)).notify).toBeNull()
    const second = decideUsageAlert(first.ledger, 'u:o', at(90, 109))
    expect(second.notify).toEqual({ level: 90, percent: 90 })
    const third = decideUsageAlert(second.ledger, 'u:o', at(100, 120))
    expect(third.notify).toEqual({ level: 100, percent: 100 })
    expect(decideUsageAlert(third.ledger, 'u:o', at(100, 130)).notify).toBeNull()
  })

  it('sends one alert for the highest level when several are crossed at once', () => {
    const jump = decideUsageAlert({}, 'u:o', at(90, 110))
    expect(jump.notify?.level).toBe(90)
    expect(jump.ledger['u:o'].levels).toEqual([75, 90])
    expect(decideUsageAlert(jump.ledger, 'u:o', at(75, 110)).notify).toBeNull()
  })

  it('alerts at the levels billing names', () => {
    const offers = team().offers!
    const custom = { offers: { ...offers, team: { ...offers.team, warnAtPercent: [50, 100] } } }
    expect(decideUsageAlert({}, 'u:o', at(50, 70, custom)).notify?.level).toBe(50)
    // 92% is past 90, but 90 isn't one of this plan's levels.
    expect(usageAlertLevel(at(50, 110, custom))).toBe(50)
  })

  it('alerts at each level billing reports when an older service names none', () => {
    const old = { offers: null }
    const first = decideUsageAlert({}, 'u:o', at(75, 92, old))
    expect(first.notify?.level).toBe(75)
    const second = decideUsageAlert(first.ledger, 'u:o', at(90, 110, old))
    expect(second.notify?.level).toBe(90)
    expect(decideUsageAlert(second.ledger, 'u:o', at(75, 110, old)).notify).toBeNull()
  })

  it('keeps accounts and teams apart', () => {
    const one = decideUsageAlert({}, 'u:org-a', at(75, 92))
    expect(decideUsageAlert(one.ledger, 'u:org-b', at(75, 92)).notify?.level).toBe(75)
    expect(decideUsageAlert(one.ledger, 'other:org-a', at(75, 92)).notify?.level).toBe(75)
  })

  it('starts over in a new billing period', () => {
    const done = decideUsageAlert({}, 'u:o', at(90, 110)).ledger
    const fresh = decideUsageAlert(done, 'u:o', at(75, 92, nextMonth))
    expect(fresh.notify?.level).toBe(75)
    expect(fresh.ledger['u:o']).toEqual({ periodStart: DEC, levels: [75] })
  })

  it('needs a period to dedupe against', () => {
    expect(
      decideUsageAlert({}, 'u:o', at(75, 92, { period: null, usageWindow: null })).notify
    ).toBeNull()
  })
})

const interpolate = (_key: string, fallback: string, options?: Record<string, string>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')

describe('notifyUsageAlertIfDue', () => {
  let dir: string
  let show: ReturnType<typeof vi.fn<UsageAlertDeps['show']>>
  let enabled: boolean
  const deps = (): UsageAlertDeps => ({
    userDataPath: dir,
    notificationsEnabled: () => enabled,
    body: (entitlement) => usageAlertSentence(entitlement, interpolate, 'en'),
    show
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-alerts-'))
    show = vi.fn<UsageAlertDeps['show']>()
    enabled = true
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('shows the alert and records it on disk, so a reload or second window does not repeat it', async () => {
    expect(await notifyUsageAlertIfDue('u:o', at(75, 92), deps())).toBe(75)
    expect(show).toHaveBeenCalledWith({
      title: USAGE_ALERT_TITLE,
      body: 'Your team has used 76% of this month’s sandbox hours.'
    })
    // Every later read (another window, a reload, a restart) reads the same ledger file.
    expect(await notifyUsageAlertIfDue('u:o', at(75, 93), deps())).toBeNull()
    expect(await notifyUsageAlertIfDue('u:o', at(75, 93), deps())).toBeNull()
    expect(show).toHaveBeenCalledTimes(1)
    expect(await readUsageAlertLedger(dir)).toEqual({ 'u:o': { periodStart: NOV, levels: [75] } })
  })

  it('does not notify members or below 75%', async () => {
    expect(
      await notifyUsageAlertIfDue('u:o', at(90, 110, { canManageBilling: false }), deps())
    ).toBeNull()
    expect(await notifyUsageAlertIfDue('u:o', at(null, 60), deps())).toBeNull()
    expect(show).not.toHaveBeenCalled()
  })

  it('notifies once when two windows read at the same moment', async () => {
    const [a, b] = await Promise.all([
      notifyUsageAlertIfDue('u:o', at(75, 92), deps()),
      notifyUsageAlertIfDue('u:o', at(75, 92), deps())
    ])
    expect([a, b].filter((level) => level !== null)).toEqual([75])
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('says what happens next at 100%, by overage', async () => {
    expect(await notifyUsageAlertIfDue('u:o', at(100, 120), deps())).toBe(100)
    expect(show).toHaveBeenLastCalledWith({
      title: USAGE_ALERT_TITLE,
      body: 'Your team has used all of this month’s sandbox hours. Running sandboxes go to sleep and new ones can’t start. Turn on overage to keep going.'
    })
    const on = { overage: { ...team().overage, optedIn: true, spendCapCents: 5000 } }
    expect(await notifyUsageAlertIfDue('u:b', at(100, 125, on), deps())).toBe(100)
    expect(show).toHaveBeenLastCalledWith({
      title: USAGE_ALERT_TITLE,
      body: 'Your team has used all of this month’s sandbox hours. Overage is on, up to your $50 spend cap.'
    })
  })

  it('counts a level as handled while notifications are off', async () => {
    enabled = false
    expect(await notifyUsageAlertIfDue('u:o', at(75, 92), deps())).toBeNull()
    enabled = true
    expect(await notifyUsageAlertIfDue('u:o', at(75, 92), deps())).toBeNull()
    expect(await notifyUsageAlertIfDue('u:o', at(90, 110), deps())).toBe(90)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('treats a corrupt ledger as empty', async () => {
    writeFileSync(join(dir, 'orca-billing-usage-alerts.json'), '{not json')
    expect(await notifyUsageAlertIfDue('u:o', at(75, 92), deps())).toBe(75)
    expect(JSON.parse(readFileSync(join(dir, 'orca-billing-usage-alerts.json'), 'utf8'))).toEqual({
      'u:o': { periodStart: NOV, levels: [75] }
    })
  })
})
