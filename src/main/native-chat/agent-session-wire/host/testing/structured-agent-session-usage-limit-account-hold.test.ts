import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW
} from './structured-agent-session-host-test-data'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'
import type { UsageLimitAccountScope } from '../../recovery/structured-agent-session-usage-limit-account-hold'

const HOUR = 60 * 60 * 1000
let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

function weekly(usedPercent: number, resetsAt: number | null, updatedAt: number) {
  return {
    provider: 'codex',
    session: {
      usedPercent: 3,
      windowMinutes: 300,
      resetsAt: updatedAt + HOUR,
      resetDescription: null
    },
    weekly: { usedPercent, windowMinutes: 10_080, resetsAt, resetDescription: null },
    updatedAt,
    error: null,
    status: 'ok'
  } satisfies ProviderRateLimits
}

/** Production sweep through dispatch, on an account whose polled reading the test sets per pass. */
async function heldChat(identityKnown: boolean) {
  let clock = HOST_TEST_NOW
  let reading: ProviderRateLimits | null = null
  let enabled = true
  const accountA: UsageLimitAccountScope = {
    scope: 'home-a',
    account: { key: 'account-a', identityKnown, read: () => reading, refresh: () => {} }
  }
  let attributed: UsageLimitAccountScope = accountA
  const current = await createQueuedMessageTestRig({
    now: () => clock,
    usageLimitAutoContinue: {
      isEnabled: () => enabled,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {},
      accountUsage: async () => attributed
    }
  })
  rig = current
  await current.store.setSessionTabVisibility(SESSION, true)
  const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const cut = await appendRewindUsageLimitedTurn(journal, clock)
  return {
    cut,
    /** Moves to `at`, where the account's last reading was taken, and runs one sweep pass. */
    pass: async (at: number, read: (now: number) => ProviderRateLimits) => {
      clock = at
      reading = read(at)
      await current.host.usageLimitContinue.tick()
      const snapshot = await current.host.journalSnapshot(SESSION)
      return snapshot.submissions.filter((submission) => submission.origin === 'host')
    },
    state: () => current.host.usageLimitContinue.readState(SESSION),
    /** The launch that a start would make now; a different scope is a different account. */
    launchUnder: (next: UsageLimitAccountScope) => {
      attributed = next
    },
    setEnabled: (next: boolean) => {
      enabled = next
    },
    setShown: (shown: boolean) => current.store.setSessionTabVisibility(SESSION, shown),
    forget: () => current.host.usageLimitContinue.forget(SESSION)
  }
}

it('holds an automatic continue until the account weekly window resets, then sends once', async () => {
  const chat = await heldChat(true)
  const weeklyReset = chat.cut.resetsAt + 3 * HOUR
  expect(
    await chat.pass(chat.cut.resetsAt + 15_000, (now) => weekly(100, weeklyReset, now))
  ).toEqual([])
  expect(chat.state()).toMatchObject({ state: 'scheduled', continueAt: weeklyReset })
  // A reading that clears the window before its own reset never lowers a known account's hold.
  expect(await chat.pass(chat.cut.resetsAt + HOUR, (now) => weekly(0, null, now))).toEqual([])
  const sent = await chat.pass(weeklyReset + 15_000, (now) => weekly(0, null, now))
  expect(sent).toHaveLength(1)
  const id = sent[0]!.clientMessageId
  await eventually(async () => expect((await rig!.submission(id))?.handedOverAt).toBeDefined())
  await rig!.settleAccepted(id, 'continued')
  expect((await rig!.submission(id))?.dispatchState).toBe('accepted')
  expect(await chat.pass(weeklyReset + 5 * 60_000, (now) => weekly(0, null, now))).toHaveLength(1)
})

it('releases a System Default hold and refusal once a fresh reading of that home has room', async () => {
  const chat = await heldChat(false)
  const weeklyReset = chat.cut.resetsAt + 3 * HOUR
  expect(
    await chat.pass(chat.cut.resetsAt + 15_000, (now) => weekly(100, weeklyReset, now))
  ).toEqual([])
  expect(await chat.pass(chat.cut.resetsAt + 60_000, (now) => weekly(100, null, now))).toEqual([])
  expect(chat.state()).toMatchObject({ state: 'failed', continueAt: weeklyReset })
  // Another login signed into the same home: its room overrides both.
  expect(await chat.pass(chat.cut.resetsAt + HOUR, (now) => weekly(0, null, now))).toHaveLength(1)
})

it('retires a hold when the launch moves to billing the reading does not describe', async () => {
  const chat = await heldChat(true)
  const weeklyReset = chat.cut.resetsAt + 3 * HOUR
  expect(
    await chat.pass(chat.cut.resetsAt + 15_000, (now) => weekly(100, weeklyReset, now))
  ).toEqual([])
  // An API-key launch from the same folder: the subscription's spent week says nothing about it.
  chat.launchUnder({ scope: 'home-a-api-key' })
  expect(
    await chat.pass(chat.cut.resetsAt + HOUR, (now) => weekly(100, weeklyReset, now))
  ).toHaveLength(1)
})

it('rebuilds a hold after restart from the reading before the cut counts as overdue', async () => {
  const chat = await heldChat(true)
  const fridayReset = chat.cut.resetsAt + 96 * HOUR
  // First pass of a fresh host two days after the cut's own reset, the week still spent.
  expect(
    await chat.pass(chat.cut.resetsAt + 48 * HOUR, (now) => weekly(100, fridayReset, now))
  ).toEqual([])
  expect(chat.state()).toMatchObject({ state: 'scheduled', continueAt: fridayReset })
  expect(await chat.pass(fridayReset + 15_000, (now) => weekly(0, null, now))).toHaveLength(1)
})

it('drops a hidden or forgotten chat hold even while automatic continue is off', async () => {
  const chat = await heldChat(true)
  const weeklyReset = chat.cut.resetsAt + 3 * HOUR
  await chat.pass(chat.cut.resetsAt + 15_000, (now) => weekly(100, weeklyReset, now))
  chat.setEnabled(false)
  await chat.setShown(false)
  await chat.pass(chat.cut.resetsAt + HOUR, (now) => weekly(100, weeklyReset, now))
  await chat.setShown(true)
  expect(chat.state()).toEqual({
    turnItemId: chat.cut.turnItemId,
    resetsAt: chat.cut.resetsAt,
    state: 'off'
  })
  chat.setEnabled(true)
  await chat.pass(chat.cut.resetsAt + 2 * HOUR, (now) => weekly(100, weeklyReset, now))
  expect(chat.state()).toMatchObject({ continueAt: weeklyReset })
  chat.forget()
  expect(chat.state()).toEqual({
    turnItemId: chat.cut.turnItemId,
    resetsAt: chat.cut.resetsAt,
    state: 'scheduled'
  })
})
