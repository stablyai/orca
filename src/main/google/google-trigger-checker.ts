// The Gmail and Calendar checks behind bots' Google rules. It rides the host's automation tick (about a
// minute) on the computer that holds the sign-ins, checks only accounts an enabled rule listens on, and
// hands each match to the same event path the cloud's Slack, GitHub and Linear deliveries take, which
// drops repeats.
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import { GoogleToolError, type GoogleApi } from './google-api-client'
import { calendarChangedSince, upcomingEvents, type UpcomingEvent } from './google-calendar-changes'
import { gmailChangesSince, gmailHistoryNow, gmailLabelIds } from './google-gmail-changes'
import {
  calendarDueAt,
  calendarRunEvent,
  gmailRuleMatches,
  gmailRunEvent,
  googleRuleTargets,
  isCalendarTarget,
  isGmailTarget,
  type GoogleRuleTarget
} from './google-trigger-match'
import { listenerKey, type GoogleTriggerState } from './google-trigger-state'

// The coming-day list is rebuilt at least this often, so a missed change can't hide a meeting long.
const SCHEDULE_MAX_AGE_MS = 30 * 60_000
const SEED_RETRY_MS = 60 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const RATE_LIMIT_BACKOFF_MS = 60_000
const ERROR_BACKOFF_MS = 5 * 60_000
const MAX_REMEMBERED_FIRES = 500

type Timer = ReturnType<typeof setTimeout>

export type GoogleTriggerCheckerDeps = {
  automations(): readonly Pick<Automation, 'id' | 'enabled' | 'bot' | 'on'>[]
  bots(): readonly Pick<Bot, 'id' | 'google'>[]
  /** Accounts signed in here that Google still accepts. */
  accounts(): string[] | Promise<string[]>
  /** Where a rule without an account listens. */
  defaultAccount(): Promise<string | null>
  api(account: string): GoogleApi | Promise<GoogleApi>
  runForEvent(automationId: string, event: AutomationRunEvent): Promise<unknown>
  readState(): GoogleTriggerState
  writeState(state: GoogleTriggerState): void
  now(): number
  tickMs: number
  setTimer?(run: () => void, ms: number): Timer
  clearTimer?(timer: Timer): void
}

export class GoogleTriggerChecker {
  private checking = false
  private stopped = false
  private readonly backoff = new Map<string, { until: number; failures: number }>()
  private readonly schedules = new Map<string, { builtAt: number; events: UpcomingEvent[] }>()
  private readonly seedFailedAt = new Map<string, number>()
  /** Each pending Calendar timer, with the rule and account it was set for. */
  private readonly timers = new Map<string, { timer: Timer; target: string }>()
  private readonly fired = new Set<string>()

  constructor(private readonly deps: GoogleTriggerCheckerDeps) {}

  /** One check, unless the last is still running. */
  tick(): Promise<void> {
    if (this.checking || this.stopped) {
      return Promise.resolve()
    }
    this.checking = true
    return this.check()
      .catch((error: unknown) => console.warn('[google] trigger check failed', error))
      .finally(() => {
        this.checking = false
      })
  }

  stop(): void {
    this.stopped = true
    for (const { timer } of this.timers.values()) {
      ;(this.deps.clearTimer ?? clearTimeout)(timer)
    }
    this.timers.clear()
  }

  private async check(): Promise<void> {
    const targets = googleRuleTargets(
      this.deps.automations(),
      this.deps.bots(),
      await this.deps.accounts(),
      await this.deps.defaultAccount()
    )
    const state = this.deps.readState()
    const before = JSON.stringify(state)
    const now = this.deps.now()
    this.trackListeners(state, targets, now)
    this.dropStaleTimers(targets)
    const accounts = new Set(targets.map((target) => target.account))
    // A checker runs only while a rule listens; with none, the next one starts from now.
    for (const account of Object.keys(state.accounts)) {
      if (!accounts.has(account)) {
        delete state.accounts[account]
      }
    }
    for (const account of accounts) {
      const mine = targets.filter((target) => target.account === account)
      const gmail = mine.filter(isGmailTarget)
      const calendar = mine.filter(isCalendarTarget)
      if (gmail.length === 0) {
        delete state.accounts[account]?.historyId
      } else {
        await this.guarded(account, 'gmail', now, () => this.checkGmail(account, gmail, state, now))
      }
      await this.guarded(account, 'calendar', now, () =>
        this.checkCalendar(account, calendar, state, now)
      )
    }
    if (JSON.stringify(state) !== before) {
      this.deps.writeState(state)
    }
  }

  // A rule that moved to another account (its own, or the default changed) stops its old timers.
  private dropStaleTimers(targets: GoogleRuleTarget[]): void {
    const current = new Set(targets.map(timerTarget))
    for (const [id, entry] of this.timers) {
      if (!current.has(entry.target)) {
        ;(this.deps.clearTimer ?? clearTimeout)(entry.timer)
        this.timers.delete(id)
      }
    }
  }

  private trackListeners(state: GoogleTriggerState, targets: GoogleRuleTarget[], now: number) {
    const listening = new Set(targets.map((target) => listenerKey(target.botId, target.account)))
    for (const key of listening) {
      state.listeners[key] ??= now
    }
    for (const key of Object.keys(state.listeners)) {
      if (!listening.has(key)) {
        delete state.listeners[key]
      }
    }
  }

  // A rate limit or an outage pauses that account's service, longer each time, never the others.
  private async guarded(
    account: string,
    service: 'gmail' | 'calendar',
    now: number,
    check: () => Promise<void>
  ): Promise<void> {
    const key = `${account} ${service}`
    const paused = this.backoff.get(key)
    if (paused && now < paused.until) {
      return
    }
    try {
      await check()
      this.backoff.delete(key)
    } catch (error) {
      const failures = (paused?.failures ?? 0) + 1
      const limited = error instanceof GoogleToolError && error.status === 429
      const base = limited ? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS
      this.backoff.set(key, {
        failures,
        until: now + Math.min(base * 2 ** (failures - 1), MAX_BACKOFF_MS)
      })
      if (failures === 1) {
        console.warn(`[google] ${service} check for ${account} failed; backing off`, error)
      }
    }
  }

  private async checkGmail(
    account: string,
    targets: GoogleRuleTarget<Extract<GoogleRuleTarget['rule'], { source: 'gmail' }>>[],
    state: GoogleTriggerState,
    now: number
  ): Promise<void> {
    const saved = (state.accounts[account] ??= {})
    const api = await this.deps.api(account)
    if (!saved.historyId) {
      saved.historyId = await gmailHistoryNow(api)
      return
    }
    const changes = await gmailChangesSince(api, saved.historyId)
    if (changes.kind === 'seeded') {
      saved.historyId = changes.historyId
      console.warn(`[google] Gmail history for ${account} expired; listening from now`)
      return
    }
    if (changes.skipped > 0) {
      console.warn(`[google] skipped ${changes.skipped} older new messages for ${account}`)
    }
    // Fetched before the history point moves, so a failure here retries the same mail next check.
    const labels = targets.some((target) => target.rule.label) ? await gmailLabelIds(api) : null
    let started = true
    for (const mail of changes.mail) {
      for (const target of targets) {
        const since = state.listeners[listenerKey(target.botId, account)] ?? now
        if (mail.at >= since && gmailRuleMatches(target.rule, mail, labels)) {
          started = (await this.fire(target.automationId, gmailRunEvent(target, mail))) && started
        }
      }
    }
    // Moves only once the batch is handed over, so a failed start sees the same mail next check.
    if (started) {
      saved.historyId = changes.historyId
    }
  }

  private async checkCalendar(
    account: string,
    targets: GoogleRuleTarget<Extract<GoogleRuleTarget['rule'], { source: 'calendar' }>>[],
    state: GoogleTriggerState,
    now: number
  ): Promise<void> {
    const ids = new Set(targets.map((target) => target.rule.calendar ?? 'primary'))
    const saved = state.accounts[account]?.calendars
    for (const id of Object.keys(saved ?? {})) {
      if (!ids.has(id)) {
        delete saved?.[id]
      }
    }
    if (ids.size === 0) {
      delete state.accounts[account]?.calendars
      return
    }
    const api = await this.deps.api(account)
    const calendars = ((state.accounts[account] ??= {}).calendars ??= {})
    for (const calendarId of ids) {
      const events = await this.schedule(
        api,
        account,
        calendarId,
        (calendars[calendarId] ??= {}),
        now
      )
      const mine = targets.filter((target) => (target.rule.calendar ?? 'primary') === calendarId)
      for (const target of mine) {
        for (const event of events) {
          await this.fireWhenDue(target, event, now)
        }
      }
    }
  }

  private async schedule(
    api: GoogleApi,
    account: string,
    calendarId: string,
    saved: { syncToken?: string },
    now: number
  ): Promise<UpcomingEvent[]> {
    const key = `${account} ${calendarId}`
    let changed = false
    // A calendar too big to seed a token for is kept fresh by the schedule's age alone.
    if (saved.syncToken || now - (this.seedFailedAt.get(key) ?? -Infinity) >= SEED_RETRY_MS) {
      const synced = await calendarChangedSince(api, calendarId, saved.syncToken)
      changed = synced.changed
      if (synced.syncToken) {
        saved.syncToken = synced.syncToken
      } else {
        delete saved.syncToken
        this.seedFailedAt.set(key, now)
      }
    }
    const built = this.schedules.get(key)
    if (built && !changed && now - built.builtAt < SCHEDULE_MAX_AGE_MS) {
      return built.events
    }
    const events = await upcomingEvents(api, calendarId, now)
    this.schedules.set(key, { builtAt: now, events })
    return events
  }

  // Due now fires now; due before the next check gets a timer, so it isn't up to a minute late.
  private async fireWhenDue(
    target: GoogleRuleTarget<Extract<GoogleRuleTarget['rule'], { source: 'calendar' }>>,
    event: UpcomingEvent,
    now: number
  ): Promise<void> {
    if (now >= event.startMs) {
      return
    }
    const dueAt = calendarDueAt(target.rule, event)
    const runEvent = calendarRunEvent(target, event)
    if (dueAt <= now) {
      await this.fire(target.automationId, runEvent)
      return
    }
    const id = `${target.automationId} ${runEvent.key}`
    if (this.stopped || dueAt - now > this.deps.tickMs || this.timers.has(id)) {
      return
    }
    const timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timers.delete(id)
      void this.fire(target.automationId, runEvent)
    }, dueAt - now)
    timer.unref?.()
    this.timers.set(id, { timer, target: timerTarget(target) })
  }

  /** False when the run path failed, so the caller keeps its cursor and the next check retries. */
  private async fire(automationId: string, event: AutomationRunEvent): Promise<boolean> {
    const id = `${automationId} ${event.key}`
    if (this.fired.has(id)) {
      return true
    }
    this.fired.add(id)
    if (this.fired.size > MAX_REMEMBERED_FIRES) {
      this.fired.delete(this.fired.values().next().value ?? '')
    }
    try {
      await this.deps.runForEvent(automationId, event)
      return true
    } catch (error) {
      // The run path drops repeats by key, so the next check can safely try again.
      this.fired.delete(id)
      console.warn('[google] could not start an automation run', error)
      return false
    }
  }
}

// Per rule: one automation's rules can listen on different accounts.
const timerTarget = (target: GoogleRuleTarget): string =>
  `${target.automationId} ${target.rule.id} ${target.account}`
