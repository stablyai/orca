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
  const current = await createQueuedMessageTestRig({
    now: () => clock,
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {},
      accountUsage: async () => ({
        key: 'account-a',
        identityKnown,
        read: () => reading,
        refresh: () => {}
      })
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
    state: () => current.host.usageLimitContinue.readState(SESSION)
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
