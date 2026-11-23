import { describe, expect, it, vi } from 'vitest'
import type { AutomationGoogleTrigger } from '../../shared/automation-google-triggers'
import type { GoogleApi } from './google-api-client'
import { GoogleTriggerChecker, type GoogleTriggerCheckerDeps } from './google-trigger-checker'
import type { GoogleTriggerState } from './google-trigger-state'

const NOW = Date.parse('2026-11-22T12:00:00Z')

// One meeting starting 10 min 50 s from now: 10- and 9-minute rules are both due within a 2-minute check.
function calendarApi(email: string): GoogleApi {
  const startsAt = new Date(NOW + 10 * 60_000 + 50_000).toISOString()
  const get: GoogleApi['get'] = async (_service, url, read) => {
    const body = new URL(url).searchParams.has('timeMin')
      ? { items: [{ id: 'standup', start: { dateTime: startsAt }, end: { dateTime: startsAt } }] }
      : { items: [], nextSyncToken: 'token' }
    const value = read(body)
    if (value === null) {
      throw new Error('unexpected page')
    }
    return value
  }
  return {
    email,
    get,
    find: async () => null,
    send: async () => {
      throw new Error('no writes')
    },
    bytes: async () => new Uint8Array()
  }
}

const rule = (id: string, account: string, minutesBefore: number): AutomationGoogleTrigger => ({
  id,
  source: 'calendar',
  event: 'starting_soon',
  account,
  minutesBefore
})

describe('Calendar timers follow their rule', () => {
  it("drops a moved rule's timer even while another rule still listens on its old account", async () => {
    let rules = [rule('r1', 'a@x.com', 10), rule('r2', 'a@x.com', 9)]
    const created: ReturnType<typeof setTimeout>[] = []
    const pending = new Set<ReturnType<typeof setTimeout>>()
    let state: GoogleTriggerState = { accounts: {}, listeners: {} }
    const deps: GoogleTriggerCheckerDeps = {
      automations: () => [
        {
          id: 'auto',
          enabled: true,
          bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' },
          on: rules
        }
      ],
      bots: () => [{ id: 'b1', google: true }],
      accounts: () => ['a@x.com', 'b@x.com'],
      defaultAccount: async () => ({ email: 'a@x.com' }),
      api: (account) => calendarApi(account),
      runForEvent: async () => undefined,
      readState: () => state,
      writeState: (next) => {
        state = next
      },
      now: () => NOW,
      tickMs: 120_000,
      // Real handles that never fire during the test; stop() clears whatever is left.
      setTimer: (run) => {
        const timer = setTimeout(run, 3_600_000)
        created.push(timer)
        pending.add(timer)
        return timer
      },
      clearTimer: (timer) => {
        clearTimeout(timer)
        pending.delete(timer)
      }
    }
    const checker = new GoogleTriggerChecker(deps)
    await checker.tick()
    expect(pending.size).toBe(2)
    // Created in rule order: r2's timer on a is the second.
    const movedRuleTimer = created.slice(1, 2)

    rules = [rule('r1', 'a@x.com', 10), rule('r2', 'b@x.com', 9)]
    await checker.tick()
    // r1 on a, and r2's new timer on b; r2's timer on a is gone.
    expect(pending.size).toBe(2)
    expect(movedRuleTimer.some((timer) => pending.has(timer))).toBe(false)
    checker.stop()
  })

  it("keeps a sibling rule's timer for the same meeting when one rule moves", async () => {
    let rules = [rule('r1', 'a@x.com', 10), rule('r2', 'a@x.com', 10)]
    const created: ReturnType<typeof setTimeout>[] = []
    const pending = new Set<ReturnType<typeof setTimeout>>()
    let state: GoogleTriggerState = { accounts: {}, listeners: {} }
    const deps: GoogleTriggerCheckerDeps = {
      automations: () => [
        {
          id: 'auto',
          enabled: true,
          bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' },
          on: rules
        }
      ],
      bots: () => [{ id: 'b1', google: true }],
      accounts: () => ['a@x.com', 'b@x.com'],
      defaultAccount: async () => ({ email: 'a@x.com' }),
      api: (account) => calendarApi(account),
      runForEvent: async () => undefined,
      readState: () => state,
      writeState: (next) => {
        state = next
      },
      now: () => NOW,
      tickMs: 120_000,
      // Real handles that never fire during the test; stop() clears whatever is left.
      setTimer: (run) => {
        const timer = setTimeout(run, 3_600_000)
        created.push(timer)
        pending.add(timer)
        return timer
      },
      clearTimer: (timer) => {
        clearTimeout(timer)
        pending.delete(timer)
      }
    }
    const checker = new GoogleTriggerChecker(deps)
    await checker.tick()
    expect(pending.size).toBe(2)
    const siblingTimer = created.slice(1, 2)

    rules = [rule('r1', 'b@x.com', 10), rule('r2', 'a@x.com', 10)]
    await checker.tick()
    // r2 still waits on a without being set again; r1 moved to b.
    expect(siblingTimer.every((timer) => pending.has(timer))).toBe(true)
    checker.stop()
  })
})

describe('rules without an account', () => {
  it('warns once while an unreadable default pauses them, and again after it recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let fallback: Awaited<ReturnType<GoogleTriggerCheckerDeps['defaultAccount']>> = {
      unreadable: 'The saved file is damaged.',
      accounts: ['a@x.com', 'b@x.com']
    }
    let state: GoogleTriggerState = { accounts: {}, listeners: {} }
    const accountless: AutomationGoogleTrigger = { id: 'r', source: 'gmail', event: 'new_email' }
    const checker = new GoogleTriggerChecker({
      automations: () => [
        {
          id: 'auto',
          enabled: true,
          bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' },
          on: [accountless]
        }
      ],
      bots: () => [{ id: 'b1', google: true }],
      accounts: () => ['a@x.com', 'b@x.com'],
      defaultAccount: async () => fallback,
      api: (account) => calendarApi(account),
      runForEvent: async () => undefined,
      readState: () => state,
      writeState: (next) => {
        state = next
      },
      now: () => NOW,
      tickMs: 120_000
    })
    const paused = () => warn.mock.calls.filter(([line]) => String(line).includes('paused')).length
    await checker.tick()
    await checker.tick()
    expect(paused()).toBe(1)
    fallback = { email: 'a@x.com' }
    await checker.tick()
    fallback = { unreadable: 'The saved file is damaged.', accounts: ['a@x.com', 'b@x.com'] }
    await checker.tick()
    expect(paused()).toBe(2)
    checker.stop()
    warn.mockRestore()
  })
})
