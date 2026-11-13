import { readTestJournalSnapshot } from '../../../agent-session-journal/journal-observation.test-support'
import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW
} from './structured-agent-session-host-test-data.test-fixture'
import { HOUR, weekly } from './structured-agent-session-usage-limit-fleet.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'
import type { UsageLimitAccountScope } from '../../recovery/structured-agent-session-usage-limit-account-hold'

const DAY = 24 * HOUR
let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

/** Production sweep through dispatch, on an account whose polled reading the test sets per pass. */
async function heldChat() {
  await rig?.dispose()
  let clock = HOST_TEST_NOW
  let launchHome = '/homes/a'
  let reading: ProviderRateLimits | null = null
  let enabled = true
  let answer: ((now: number) => ProviderRateLimits) | undefined
  const accountA: UsageLimitAccountScope = {
    scope: 'home-a',
    account: {
      key: 'account-a',
      read: () => reading,
      refresh: () => {
        reading = answer?.(clock) ?? reading
        return true
      }
    }
  }
  let attributed: UsageLimitAccountScope = accountA
  const current = await createQueuedMessageTestRig({
    now: () => clock,
    restartable: true,
    acquiredAccountHome: () => ({ variable: 'CODEX_HOME', path: launchHome }),
    usageLimitAutoContinue: {
      isEnabled: () => enabled,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {},
      accountUsage: async () => attributed
    }
  })
  rig = current
  current.host.deps.launchAccountHome = async () => ({ variable: 'CODEX_HOME', path: launchHome })
  await eventually(() =>
    expect(current.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  )
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
      return (await readTestJournalSnapshot(journal)).submissions.filter(
        (submission) => submission.origin === 'host'
      )
    },
    /** A pass with no reading arriving except what a requested refresh brings. */
    quietPass: async (at: number) => {
      clock = at
      await current.host.usageLimitContinue.tick()
      return (await readTestJournalSnapshot(journal)).submissions.filter(
        (submission) => submission.origin === 'host'
      )
    },
    /** What a requested refresh returns from now on; nothing arrives unasked otherwise. */
    answerRefresh: (next: (now: number) => ProviderRateLimits) => {
      answer = next
    },
    state: async () =>
      current.host.usageLimitContinue.readState(SESSION, await journal.reads.usageLimitCut()),
    /** The launch that a start would make now; a different scope is a different account. */
    launchUnder: (next: UsageLimitAccountScope) => {
      attributed = next
    },
    /** The cut's runtime launched on account A; a start of this chat would now launch on `path`. */
    switchAccount: async (path: string) => {
      launchHome = path
    },
    setEnabled: (next: boolean) => {
      enabled = next
    },
    setShown: (shown: boolean) => current.store.setSessionTabVisibility(SESSION, shown),
    forget: () => current.host.usageLimitContinue.forget(SESSION)
  }
}

/** The one continue a pass sent, carried through to an accepted settlement. */
async function settleOne(sent: readonly { clientMessageId: string }[]) {
  expect(sent).toHaveLength(1)
  const id = sent[0]!.clientMessageId
  await eventually(async () => expect((await rig!.submission(id))?.handedOverAt).toBeDefined())
  await rig!.settleAccepted(id, 'continued')
  expect((await rig!.submission(id))?.dispatchState).toBe('accepted')
}

it('releases a held continue on room newer than its spent evidence, even days after the cut', async () => {
  const chat = await heldChat()
  const reset = chat.cut.resetsAt
  const friday = reset + 96 * HOUR
  expect(await chat.pass(reset + 15_000, (now) => weekly(100, friday, now))).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: friday })
  // Room in a reading taken before that spending changes nothing.
  expect(await chat.pass(reset + HOUR, () => weekly(0, null, reset + 5_000))).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: friday })
  // Wednesday, over a day past the cut's reset: fresh room releases it from that reading on.
  const wednesday = reset + 48 * HOUR
  expect(await chat.pass(wednesday, (now) => weekly(0, null, now))).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: wednesday })
  await settleOne(await chat.pass(wednesday + 15_000, (now) => weekly(0, null, now)))
  expect(await chat.pass(wednesday + 5 * 60_000, (now) => weekly(0, null, now))).toHaveLength(1)
})

it('holds again on spending inside the grace, and leaves an unknown reset once room returns', async () => {
  const held = await heldChat()
  const reset = held.cut.resetsAt
  await held.pass(reset + 15_000, (now) => weekly(100, reset + 96 * HOUR, now))
  const wednesday = reset + 48 * HOUR
  expect(await held.pass(wednesday, (now) => weekly(0, null, now))).toEqual([])
  const sessionReset = wednesday + 5 * HOUR
  const spentSession = { usedPercent: 100, resetsAt: sessionReset }
  for (const at of [wednesday + 10_000, wednesday + 20_000]) {
    expect(await held.pass(at, (now) => weekly(0, null, now, spentSession))).toEqual([])
  }
  expect(await held.state()).toMatchObject({ state: 'scheduled', continueAt: sessionReset })

  const refused = await heldChat()
  const cutReset = refused.cut.resetsAt
  expect(await refused.pass(cutReset + 15_000, (now) => weekly(100, null, now))).toEqual([])
  expect(await refused.pass(cutReset + 20 * HOUR, (now) => weekly(100, null, now))).toEqual([])
  expect(await refused.state()).toBeUndefined()
  // Room over a day after the cut's reset, while the refusal still stood: scheduled again.
  const room = cutReset + 30 * HOUR
  expect(await refused.pass(room, (now) => weekly(0, null, now))).toEqual([])
  expect(await refused.state()).toMatchObject({ state: 'scheduled' })
  await settleOne(await refused.pass(room + 15_000, (now) => weekly(0, null, now)))
})

it('continues before the cut resets once the chat would start on another account with room', async () => {
  const chat = await heldChat()
  const start = chat.cut.resetsAt - 60_000
  await chat.switchAccount('/homes/b')
  expect(await chat.pass(start + 5_000, (now) => weekly(0, null, now))).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: start + 5_000 })
  await settleOne(await chat.pass(start + 20_000, (now) => weekly(0, null, now)))
})

it('keeps the new account spent from a reading before the switch until a later one shows room', async () => {
  const chat = await heldChat()
  const start = chat.cut.resetsAt - 60_000
  const newAccountReset = start + 2 * HOUR
  await chat.switchAccount('/homes/b')
  expect(await chat.pass(start + 5_000, () => weekly(100, newAccountReset, start + 1_000))).toEqual(
    []
  )
  expect(await chat.state()).toMatchObject({ continueAt: newAccountReset })
  expect(await chat.pass(start + 10 * 60_000, () => weekly(100, newAccountReset, start))).toEqual(
    []
  )
  const room = start + 20 * 60_000
  expect(await chat.pass(room, (now) => weekly(0, null, now))).toEqual([])
  expect(await chat.state()).toMatchObject({ continueAt: room })
  await settleOne(await chat.pass(room + 15_000, (now) => weekly(0, null, now)))
})

it('retires a hold when the launch moves to billing the reading does not describe', async () => {
  const chat = await heldChat()
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
  const chat = await heldChat()
  const fridayReset = chat.cut.resetsAt + 96 * HOUR
  // First pass of a fresh host two days after the cut's own reset, the week still spent.
  expect(
    await chat.pass(chat.cut.resetsAt + 48 * HOUR, (now) => weekly(100, fridayReset, now))
  ).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: fridayReset })
  expect(await chat.pass(fridayReset + 15_000, (now) => weekly(0, null, now))).toHaveLength(1)
})

it('drops a hidden chat hold while automatic continue is off, and keeps it when the chat opens', async () => {
  const chat = await heldChat()
  const weeklyReset = chat.cut.resetsAt + 3 * HOUR
  await chat.pass(chat.cut.resetsAt + 15_000, (now) => weekly(100, weeklyReset, now))
  chat.setEnabled(false)
  await chat.setShown(false)
  await chat.pass(chat.cut.resetsAt + HOUR, (now) => weekly(100, weeklyReset, now))
  await chat.setShown(true)
  expect(await chat.state()).toEqual({
    turnItemId: chat.cut.turnItemId,
    resetsAt: chat.cut.resetsAt,
    state: 'off'
  })
  chat.setEnabled(true)
  await chat.pass(chat.cut.resetsAt + 2 * HOUR, (now) => weekly(100, weeklyReset, now))
  expect(await chat.state()).toMatchObject({ continueAt: weeklyReset })
  // Opening the chat re-reads its cut; the account hold is still the account's.
  chat.forget()
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: weeklyReset })
})

it('never revives an old cut with a spent window that began after its reset', async () => {
  const chat = await heldChat()
  const laterReset = chat.cut.resetsAt + 23 * DAY
  expect(
    await chat.pass(chat.cut.resetsAt + 21 * DAY, (now) => weekly(100, laterReset, now))
  ).toEqual([])
  expect(await chat.state()).toBeUndefined()
  expect(await chat.pass(laterReset + 15_000, (now) => weekly(0, null, now))).toEqual([])
})

it('asks for a first reading when a late first pass finds none, and waits for it', async () => {
  const chat = await heldChat()
  let asked = 0
  // The first ask lands while another fetch is running, so the service starts no read.
  chat.launchUnder({ scope: 'home-a', bootstrap: () => ++asked > 1 })
  // A restart an hour after the reset, before any reading names where it was taken.
  expect(await chat.pass(chat.cut.resetsAt + HOUR, (now) => weekly(0, null, now))).toEqual([])
  expect(asked).toBe(1)
  expect(await chat.pass(chat.cut.resetsAt + HOUR + 10_000, (now) => weekly(0, null, now))).toEqual(
    []
  )
  expect(asked).toBe(2)
  expect(await chat.pass(chat.cut.resetsAt + HOUR + 60_000, (now) => weekly(0, null, now))).toEqual(
    []
  )
  expect(asked).toBe(2)
  expect(
    await chat.pass(chat.cut.resetsAt + HOUR + 120_000, (now) => weekly(0, null, now))
  ).toHaveLength(1)
})

it('holds a still-eligible cut for a spent window that began after its reset', async () => {
  const chat = await heldChat()
  const reset = chat.cut.resetsAt
  const sessionSpentUntil = { usedPercent: 100, resetsAt: reset + 10 * HOUR }
  expect(
    await chat.pass(reset + 6 * HOUR, (now) => weekly(0, null, now, sessionSpentUntil))
  ).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: reset + 10 * HOUR })
  expect(await chat.pass(reset + 10 * HOUR + 15_000, (now) => weekly(0, null, now))).toHaveLength(1)
})

it('extends a weekly hold for a session window still spent at the weekly reset', async () => {
  const chat = await heldChat()
  const friday = chat.cut.resetsAt + 96 * HOUR
  expect(await chat.pass(chat.cut.resetsAt + 15_000, (now) => weekly(100, friday, now))).toEqual([])
  const sessionSpentUntil = { usedPercent: 100, resetsAt: friday + 2 * HOUR }
  expect(
    await chat.pass(friday + 15_000, (now) => weekly(0, friday + 7 * DAY, now, sessionSpentUntil))
  ).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: friday + 2 * HOUR })
  const sent = await chat.pass(friday + 2 * HOUR + 15_000, (now) => weekly(0, null, now))
  expect(sent).toHaveLength(1)
  const id = sent[0]!.clientMessageId
  await eventually(async () => expect((await rig!.submission(id))?.handedOverAt).toBeDefined())
  await rig!.settleAccepted(id, 'continued')
  expect((await rig!.submission(id))?.dispatchState).toBe('accepted')
})

it('rebuilds a covering hold beside a spent window of unknown reset, then settles after the release', async () => {
  const chat = await heldChat()
  const weeklyReset = chat.cut.resetsAt + 96 * HOUR
  const sessionUnknown = { usedPercent: 100, resetsAt: null }
  // A restart two days after the cut: the covering week holds it; the unknown session refuses for now.
  expect(
    await chat.pass(chat.cut.resetsAt + 48 * HOUR, (now) =>
      weekly(100, weeklyReset, now, sessionUnknown)
    )
  ).toEqual([])
  expect(await chat.state()).toBeUndefined()
  // A fresh reading with room releases the refusal; the send counts from that reading.
  const room = weeklyReset + 15_000
  expect(await chat.pass(room, (now) => weekly(0, null, now))).toEqual([])
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: room })
  await settleOne(await chat.pass(room + 15_000, (now) => weekly(0, null, now)))
  expect(await chat.pass(room + 5 * 60_000, (now) => weekly(0, null, now))).toHaveLength(1)
})

it('asks for readings while a reset is unknown, and releases an expired hold from the room it brings', async () => {
  const chat = await heldChat()
  const reset = chat.cut.resetsAt
  expect(await chat.pass(reset + 15_000, (now) => weekly(100, reset + 3 * HOUR, now))).toEqual([])
  expect(await chat.pass(reset + 2 * HOUR, (now) => weekly(100, null, now))).toEqual([])
  // Unfocused overnight: the poller is idle, so only readings the sweep asks for arrive.
  chat.answerRefresh((now) => weekly(100, null, now))
  for (const at of [reset + 12 * HOUR, reset + 22 * HOUR]) {
    expect(await chat.quietPass(at)).toEqual([])
  }
  // Fresh room can still release it, so the row shows no automatic continue either way.
  expect(await chat.state()).toBeUndefined()
  chat.answerRefresh((now) => weekly(0, null, now))
  const room = reset + 30 * HOUR
  expect(await chat.quietPass(room)).toEqual([])
  // That room came 27 h after the finite hold ran out; the send still counts from the room.
  expect(await chat.state()).toMatchObject({ state: 'scheduled', continueAt: room })
  await settleOne(await chat.quietPass(room + 15_000))
  expect(await chat.quietPass(room + 5 * 60_000)).toHaveLength(1)
})

it('keeps a cancelled cut on its own reset while the account shows an unknown reset', async () => {
  const chat = await heldChat()
  const reset = chat.cut.resetsAt
  await chat.pass(reset - 60_000, (now) => weekly(0, null, now))
  await rig!.host.usageLimitContinue.cancel({
    sessionId: SESSION,
    turnItemId: chat.cut.turnItemId,
    resetsAt: reset
  })
  expect(await chat.pass(reset + HOUR, (now) => weekly(100, null, now))).toEqual([])
  expect(await chat.state()).toEqual({
    turnItemId: chat.cut.turnItemId,
    resetsAt: reset,
    state: 'cancelled'
  })
})
