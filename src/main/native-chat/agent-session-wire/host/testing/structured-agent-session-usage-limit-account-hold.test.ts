import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW,
  hostTestRestingOptionsRecord
} from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { RestartContinuationSupersededError } from '../../recovery/structured-agent-session-restart-continuation'
import { StructuredAgentSessionUsageLimitContinue } from '../../recovery/structured-agent-session-usage-limit-continue'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'
import type { UsageLimitAccountScope } from '../../recovery/structured-agent-session-usage-limit-account-hold'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
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

it('drops a hidden chat hold while automatic continue is off, and keeps it when the chat opens', async () => {
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
  // Opening the chat re-reads its cut; the account hold is still the account's.
  chat.forget()
  expect(chat.state()).toMatchObject({ state: 'scheduled', continueAt: weeklyReset })
})

it('never revives an old cut with a spent window that began after its reset', async () => {
  const chat = await heldChat(true)
  const laterReset = chat.cut.resetsAt + 23 * DAY
  expect(
    await chat.pass(chat.cut.resetsAt + 21 * DAY, (now) => weekly(100, laterReset, now))
  ).toEqual([])
  expect(chat.state()).toBeUndefined()
  expect(await chat.pass(laterReset + 15_000, (now) => weekly(0, null, now))).toEqual([])
})

it('asks for a first reading when a late first pass finds none, and waits for it', async () => {
  const chat = await heldChat(true)
  let asked = 0
  chat.launchUnder({ scope: 'home-a', bootstrap: () => asked++ })
  // A restart an hour after the reset, before any reading names where it was taken.
  expect(await chat.pass(chat.cut.resetsAt + HOUR, (now) => weekly(0, null, now))).toEqual([])
  expect(asked).toBe(1)
  expect(await chat.pass(chat.cut.resetsAt + HOUR + 60_000, (now) => weekly(0, null, now))).toEqual(
    []
  )
  expect(asked).toBe(1)
  expect(
    await chat.pass(chat.cut.resetsAt + HOUR + 120_000, (now) => weekly(0, null, now))
  ).toHaveLength(1)
})

/** N loaded chats on one account, all due; the first dispatch brings a reading that spends the week. */
async function queuedBehindSpentReading(count: number) {
  const now = HOST_TEST_NOW
  const weeklyReset = now + 3 * HOUR
  const ids = Array.from({ length: count }, (_, index) => `chat-${index}`)
  let reading = weekly(0, null, now)
  const calls = { launchHome: 0, reader: 0 }
  const dispatched: string[] = []
  const sweep = new StructuredAgentSessionUsageLimitContinue({
    host: {
      logger: recordingStructuredAgentSessionLogger().logger,
      launchAccountHome: async () => {
        calls.launchHome++
        return { variable: 'CODEX_HOME', path: '/homes/a' }
      },
      usageLimitAutoContinue: {
        isEnabled: () => true,
        isWorkspaceAsleep: () => false,
        subscribe: () => () => {},
        accountScopeToken: () => 'account-a',
        accountUsage: async () => {
          calls.reader++
          return {
            scope: 'home-a',
            account: {
              key: 'account-a',
              identityKnown: true,
              read: () => reading,
              refresh: () => {}
            }
          }
        }
      },
      store: {
        hostId: 'local',
        listVisibleSessionIds: () => ids,
        isSessionTabVisible: () => true,
        cancelUsageLimitContinue: async (id) => hostTestRestingOptionsRecord(id),
        getRecord: (id) => hostTestRestingOptionsRecord(id)
      }
    },
    sessions: new Map(ids.map((id) => [id, {}])),
    readSavedCut: () => null,
    readLoadedCut: (id) => ({
      turnItemId: `${id}-turn`,
      resetsAt: now - 60_000,
      turnEndedAt: now - 120_000,
      chain: 0
    }),
    serialize: (_id, run) => run(),
    // Answered as superseded, which spends no budget; only what reached dispatch matters here.
    send: async (params) => {
      params.beforeRun?.()
      dispatched.push(params.envelope.sessionId)
      reading = weekly(100, weeklyReset, now)
      throw new RestartContinuationSupersededError()
    },
    publish: () => {},
    now: () => now
  })
  await sweep.tick()
  return { calls, dispatched, last: sweep.readState(ids[count - 1]!) }
}

it('shares attribution for queued continuations blocked by a newer reading at N and 10N', async () => {
  for (const count of [300, 3000]) {
    const fleet = await queuedBehindSpentReading(count)
    expect(fleet.dispatched).toEqual(['chat-0'])
    expect(fleet.last).toMatchObject({ state: 'scheduled', continueAt: HOST_TEST_NOW + 3 * HOUR })
    expect(fleet.calls).toEqual({ launchHome: 1, reader: 1 })
  }
})
