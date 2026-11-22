import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import {
  appendRewindUsageLimitedTurn,
  appendUsageLimitedTurn
} from './structured-agent-session-rewind-usage-limit.test-fixture'
import { journalSqlReads } from '../../../agent-session-journal/journal-sql-reads'
import { latestNativeChatUsageLimitCut } from '../../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'

// Another agent's mail waits behind a failed turn, queued with the person's own follow-ups, until
// the chat continues: Resume, the person's own send, or the automatic continue at a usage-limit reset.
let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const AGENT: AgentMessageSource = { kind: 'agent', senders: [], orchestration: null }

async function held(): Promise<boolean> {
  return (await rig.host.conversation(SESSION)).journal.queuedMessages.failureHolds()
}

async function appendTurn(name: string, outcome: 'success' | 'failure'): Promise<void> {
  const journal = (await rig.host.conversation(SESSION)).journal
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `turn-${name}` },
    {
      kind: 'turn',
      turnId: name,
      providerTurnId: name,
      state: 'completed',
      outcome,
      startedAt: HOST_TEST_NOW,
      completedAt: HOST_TEST_NOW
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** Another agent's message, sent as the mailbox sends one; resolves to its queued card's id. */
async function mail(text: string): Promise<string> {
  const result = await rig.send(text, 'queue-if-active', { internal: true, from: AGENT }).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error(`expected mail to queue, got ${JSON.stringify(result)}`)
  }
  return result.value.queued.messageId
}

/** The chat publishes the card as held behind the failed turn, and nothing has handed it over. */
async function stillWaiting(card: string): Promise<void> {
  expect(await rig.queuePause()).toEqual({ reason: 'failed' })
  expect(await rig.drafts()).toEqual([{ messageId: card, state: 'waiting' }])
  expect(await rig.handoff(card)).toBeUndefined()
}

async function failedChat(): Promise<void> {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'working')
  await openRigTurnFor(rig, working)
  await openRigTurnFor(rig, working, 'completed', 'failure')
}

function autoContinueRig(clock: () => number) {
  return createQueuedMessageTestRig({
    now: clock,
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {}
    }
  })
}

/** The automatic continue's send, once handed over. */
async function continuation(): Promise<string> {
  let id: string | undefined
  await eventually(async () => {
    id = (await readTestHostJournal(rig.host, SESSION)).submissions.find(
      (submission) =>
        submission.origin === 'host' &&
        submission.queuedMessageId === undefined &&
        submission.handedOverAt !== undefined
    )?.clientMessageId
    expect(id).toBeDefined()
  })
  return id!
}

/** The cut both walks read: the shared one over the rendered journal, and the host's database one. */
async function usageLimitCuts() {
  const journal = await readTestHostJournal(rig.host, SESSION)
  return {
    shared: latestNativeChatUsageLimitCut(journal.items, journal.submissions)?.turnItemId ?? null,
    host:
      (await journalSqlReads(rig.host.deps.journalDatabase.readers, SESSION).usageLimitCut())
        ?.turnItemId ?? null
  }
}

function refuse(clientMessageId: string, refusal: 'notDelivered' | 'unconfirmed') {
  return rig.host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId,
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact(
        refusal,
        refusal === 'notDelivered' ? { neverReachedAgent: true } : {}
      ),
      { surface: 'rejection' }
    )
  })
}

async function handedOver(card: string): Promise<string> {
  let id: string | undefined
  await eventually(async () => {
    const sent = await rig.handoff(card)
    expect(sent?.handedOverAt).toBeDefined()
    id = sent!.clientMessageId
  })
  return id!
}

/** #46650: queued mail is handed over just as the turn ends on a usage limit, and the agent refuses it. */
async function mailRefusedAtUsageLimit(clock: number) {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'working')
  await openRigTurnFor(rig, working)
  const card = await mail('update the install docs')
  await openRigTurnFor(rig, working, 'completed', 'success')
  const handoff = await handedOver(card)
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const cut = await appendUsageLimitedTurn(journal, clock, 'mail-race')
  await refuse(handoff, 'notDelivered')
  return { card, cut }
}

describe("a chat's hold on another agent's mail", () => {
  it('holds it once the last turn failed, until a newer turn runs', async () => {
    rig = await createQueuedMessageTestRig()
    expect(await held()).toBe(false)
    await appendTurn('finished', 'success')
    expect(await held()).toBe(false)
    await appendTurn('network-error', 'failure')
    expect(await held()).toBe(true)
    await appendTurn('recovered', 'success')
    expect(await held()).toBe(false)
  })

  it('queues mail after a failed turn and runs it as the next turn on Resume', async () => {
    rig = await createQueuedMessageTestRig()
    await failedChat()
    const card = await mail('update the install docs')
    await stillWaiting(card)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect((await rig.handoff(card))?.handedOverAt).toBeDefined())
  })

  it("runs queued mail after the person's own send recovers the chat", async () => {
    rig = await createQueuedMessageTestRig()
    await failedChat()
    const card = await mail('update the install docs')
    await stillWaiting(card)
    const person = rig.send('try again')
    expect(await person.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(person.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(person.id, 'person')
    await openRigTurnFor(rig, person.id, 'completed', 'success')
    await eventually(async () => expect((await rig.handoff(card))?.handedOverAt).toBeDefined())
  })

  it('runs queued mail once the automatic continue at a usage-limit reset succeeds', async () => {
    let clock = HOST_TEST_NOW
    rig = await createQueuedMessageTestRig({
      now: () => clock,
      usageLimitAutoContinue: {
        isEnabled: () => true,
        isWorkspaceAsleep: () => false,
        subscribe: () => () => {}
      }
    })
    const current = rig
    // Agent chats run without a tab.
    await current.store.setSessionTabVisibility(SESSION, false, undefined, { background: true })
    const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const cut = await appendRewindUsageLimitedTurn(journal, clock)
    const card = await mail('update the install docs')
    await stillWaiting(card)
    clock = cut.resetsAt + 15_000
    await current.host.usageLimitContinue.tick()
    let continuation: string | undefined
    await eventually(async () => {
      continuation = (await readTestHostJournal(current.host, SESSION)).submissions.find(
        (submission) => submission.origin === 'host' && submission.handedOverAt !== undefined
      )?.clientMessageId
      expect(continuation).toBeDefined()
    })
    expect(await current.handoff(card)).toBeUndefined()
    await current.settleAccepted(continuation!, 'continued')
    await openRigTurnFor(current, continuation!, 'completed', 'success')
    await eventually(async () => expect((await current.handoff(card))?.handedOverAt).toBeDefined())
  })

  it('continues at the reset when the queued mail handed over at the limit was refused', async () => {
    let clock = HOST_TEST_NOW
    rig = await autoContinueRig(() => clock)
    await rig.store.setSessionTabVisibility(SESSION, false, undefined, { background: true })
    const { card, cut } = await mailRefusedAtUsageLimit(clock)
    const refused = (await rig.handoff(card))!.clientMessageId
    expect(await usageLimitCuts()).toEqual({ shared: cut.turnItemId, host: cut.turnItemId })
    expect(await rig.queuePause()).toEqual({ reason: 'failed' })
    expect(await rig.drafts()).toEqual([{ messageId: card, state: 'waiting' }])
    clock = cut.resetsAt + 15_000
    await rig.host.usageLimitContinue.tick()
    const continued = await continuation()
    await rig.settleAccepted(continued, 'continued')
    await openRigTurnFor(rig, continued, 'completed', 'success')
    await eventually(async () => {
      const sent = await rig.handoff(card)
      expect(sent?.clientMessageId).not.toBe(refused)
      expect(sent?.handedOverAt).toBeDefined()
    })
  })

  it('does not continue past queued mail the agent may have read after the limit', async () => {
    let clock = HOST_TEST_NOW
    rig = await autoContinueRig(() => clock)
    await rig.store.setSessionTabVisibility(SESSION, false, undefined, { background: true })
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const cut = await appendUsageLimitedTurn(journal, clock, 'limited')
    const card = await mail('update the install docs')
    await stillWaiting(card)
    expect(await rig.sendNow(card)).toMatchObject({ ok: true })
    await refuse(await handedOver(card), 'unconfirmed')
    expect(await usageLimitCuts()).toEqual({ shared: null, host: null })
    clock = cut.resetsAt + 15_000
    await rig.host.usageLimitContinue.tick()
    const sent = (await readTestHostJournal(rig.host, SESSION)).submissions
    expect(sent.filter((submission) => submission.queuedMessageId === undefined)).toEqual([])
  })
})
