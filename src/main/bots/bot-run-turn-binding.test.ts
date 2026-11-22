// Gate G4 through the real native-chat host: a run in a busy Chat reports only the turn it started.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { sendAgentTurn } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { chatThatTookIt } from './bot-automation-sessions'
import { botMessageBody, type BotRunFields } from './bot-chat-session'
import { deliverBotRunResult, type BotRunDeliveryDependencies } from './bot-run-results'
import { watchBotTurnEnds, type BotRunSend, type BotTurnEnd } from './bot-run-turn-watch'
import { makeTestBot } from './bot.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

/** A run's prompt, sent as the bot's Chat sends it: queued behind a running turn. */
async function sendRun(text: string, run?: BotRunFields): Promise<BotRunSend> {
  const body = botMessageBody(text, run)
  const outcome = await sendAgentTurn({
    kind: 'structured-session',
    host: rig.host,
    sessionId: SESSION,
    callerKey: 'bot-chat:bot-1',
    turn: {
      body,
      personsMessage: true,
      operationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      delivery: 'queue'
    }
  })
  return chatThatTookIt({
    sessionId: SESSION,
    outcome,
    fingerprint: agentSessionSendBodyFingerprint(SESSION, body)
  })
}

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function turnIdentity(id: string): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: THREAD, turnId: `turn-of-${id}`, ordinal: 0 }
}

/** The provider opens the send's turn, then echoes the send, as Codex and Claude do. */
async function openTurn(id: string): Promise<void> {
  await journal().appendItem(
    turnIdentity(id),
    {
      kind: 'turn',
      turnId: `turn-of-${id}`,
      state: 'running',
      startedAt: NOW,
      userItemId: agentJournalSubmissionKey(id)
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.settleAccepted(id, id)
}

/** The agent's prose in the send's turn; a later ordinal is a later message. */
async function say(id: string, text: string, ordinal = 1): Promise<void> {
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `turn-of-${id}`, ordinal },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turnIdentity(id)) } }
  )
}

async function endTurn(
  id: string,
  { answer, outcome = 'success' }: { answer?: string; outcome?: AgentJournalTurnOutcome } = {}
): Promise<void> {
  if (answer) {
    await say(id, answer)
  }
  await journal().appendItem(
    turnIdentity(id),
    {
      kind: 'turn',
      turnId: `turn-of-${id}`,
      state: outcome === 'cancellation' ? 'interrupted' : 'completed',
      outcome,
      startedAt: NOW,
      completedAt: NOW,
      userItemId: agentJournalSubmissionKey(id)
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** The owner's own turn, running when the runs arrive. */
async function ownerTurn(): Promise<string> {
  const owner = await rig.workingSend()
  await openTurn(owner)
  return owner
}

async function handedOver(send: BotRunSend): Promise<string> {
  await eventually(async () => expect(await rig.handoff(send.clientMessageId)).toBeDefined())
  return rig.handoffId(send.clientMessageId)
}

/** Sent now: its handoff, which the host plans to steer into the running turn. */
async function sentNow(send: BotRunSend, owner: string): Promise<string> {
  expect(await rig.sendNow(send.clientMessageId)).toMatchObject({ ok: true })
  const steer = await handedOver(send)
  await eventually(async () =>
    expect((await journal().reads.itemDetail(agentJournalSubmissionKey(steer)))?.turnScope).toEqual(
      {
        kind: 'turn',
        turnItemId: agentJournalItemKey(turnIdentity(owner))
      }
    )
  )
  return steer
}

/** What a channel and a Linear issue would be sent for this end. */
async function postsFor(ended: BotTurnEnd) {
  const postAsBot = vi.fn<BotRunDeliveryDependencies['postAsBot']>(async () => ({
    ok: true as const,
    value: undefined
  }))
  for (const resultsTo of [{ channel: 'C123' }, { linearIssue: 'ENG-123' }]) {
    await deliverBotRunResult(
      {
        sendToChat: async () => undefined,
        noteToChat: async () => undefined,
        postAsBot,
        replyInThread: () => null,
        turnForOf: async () => 'owner',
        notify: () => {},
        cloudSignedOut: () => false,
        noteToRun: async () => undefined
      },
      {
        automation: { id: 'auto-1', name: 'Alert triage', dtstart: 1 },
        run: { id: 'run-1', trigger: 'scheduled' },
        bot: makeTestBot(),
        target: { runsIn: 'chat', resultsTo },
        sessionId: SESSION,
        ended
      }
    )
  }
  return postAsBot.mock.calls
}

describe('a bot run in a busy Chat', () => {
  it('reports only its own turn, behind the owner and another run', async () => {
    const owner = await ownerTurn()
    const firstWatch = watchBotTurnEnds(rig.host)
    const first = await sendRun('Investigate alert 1')
    const secondWatch = watchBotTurnEnds(rig.host)
    const second = await sendRun('Investigate alert 2')
    const firstEnd = firstWatch.next(first)
    const secondEnd = secondWatch.next(second)

    await endTurn(owner, { answer: "The owner's answer." })
    const firstTurn = await handedOver(first)
    await openTurn(firstTurn)
    await endTurn(firstTurn, { answer: 'Alert 1 is a flaky test.' })
    const secondTurn = await handedOver(second)
    await openTurn(secondTurn)
    await endTurn(secondTurn, { answer: 'Alert 2 is a real outage.' })

    await expect(firstEnd).resolves.toEqual({
      outcome: 'success',
      message: 'Alert 1 is a flaky test.'
    })
    await expect(secondEnd).resolves.toEqual({
      outcome: 'success',
      message: 'Alert 2 is a real outage.'
    })
  })

  it('keeps its run on the message, reports its turn, and refuses the owner an edit', async () => {
    const automationRun = {
      runId: 'run-1',
      automation: {
        id: 'auto-1',
        name: 'Alert triage',
        enabled: true,
        nextRunAt: NOW,
        updatedAt: 1,
        dtstart: 1,
        rrule: 'FREQ=DAILY',
        workspaceId: null
      },
      trigger: 'scheduled' as const,
      scheduledFor: NOW,
      instructionsLength: 'Investigate alert'.length
    }
    const owner = await ownerTurn()
    const watch = watchBotTurnEnds(rig.host)
    const run = await sendRun('Investigate alert', {
      memorySource: 'Automation Alert triage',
      automationRun
    })
    const ended = watch.next(run)

    const card = await journal().queuedMessages.get(run.clientMessageId)
    expect(card?.body).toMatchObject({ origin: 'automation-run', automationRun })
    const fields = {
      messageId: run.clientMessageId,
      expectedBodyFingerprint: card?.fingerprint ?? '',
      text: 'Draft my private reply instead'
    }
    expect(
      await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true, value: { status: 'not-editable' } })
    await endTurn(owner, { answer: "The owner's answer." })
    const turn = await handedOver(run)
    await openTurn(turn)
    await endTurn(turn, { answer: 'Alert is a flaky test.' })

    await expect(ended).resolves.toEqual({ outcome: 'success', message: 'Alert is a flaky test.' })
  })

  it('has no result, never the previous message, when its turn wrote no text', async () => {
    const owner = await ownerTurn()
    const watch = watchBotTurnEnds(rig.host)
    const run = await sendRun('Investigate alert')
    const ended = watch.next(run)

    await endTurn(owner, { answer: "The owner's answer." })
    const turn = await handedOver(run)
    await openTurn(turn)
    await endTurn(turn)

    await expect(ended).resolves.toEqual({ outcome: 'success', message: '' })
  })

  it('is result_unavailable when its queued message is taken out of the queue', async () => {
    const owner = await ownerTurn()
    const watch = watchBotTurnEnds(rig.host)
    const run = await sendRun('Investigate alert')
    const ended = watch.next(run)

    expect(await rig.deleteQueued(run.clientMessageId)).toMatchObject({ ok: true })
    await endTurn(owner, { answer: "The owner's answer." })

    await expect(ended).resolves.toEqual({ unavailable: 'removed' })
  })

  it('is result_unavailable when the owner edits its queued message, which still goes', async () => {
    const owner = await ownerTurn()
    const watch = watchBotTurnEnds(rig.host)
    const run = await sendRun('Investigate alert')
    const ended = watch.next(run)

    const card = await journal().queuedMessages.get(run.clientMessageId)
    const fields = {
      messageId: run.clientMessageId,
      expectedBodyFingerprint: card?.fingerprint ?? '',
      text: 'Draft my private reply instead'
    }
    expect(
      await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true, value: { status: 'updated' } })
    await endTurn(owner, { answer: "The owner's answer." })
    const turn = await handedOver(run)
    await openTurn(turn)
    await endTurn(turn, { answer: 'Owner private answer.' })

    await expect(ended).resolves.toEqual({ unavailable: 'edited' })
  })

  it('sent now into the running turn, posts nothing from that shared turn', async () => {
    const owner = await ownerTurn()
    const firstWatch = watchBotTurnEnds(rig.host)
    const first = await sendRun('Investigate alert 1')
    const secondWatch = watchBotTurnEnds(rig.host)
    const second = await sendRun('Investigate alert 2')
    const ends = [firstWatch.next(first), secondWatch.next(second)]

    await say(owner, 'PRIVATE OWNER TEXT')
    // Codex takes a steer under the running turn's own provider id.
    await rig.settleAccepted(await sentNow(first, owner), owner)
    await say(owner, 'ALERT 1 RESULT', 2)
    await rig.settleAccepted(await sentNow(second, owner), owner)
    await say(owner, 'ALERT 2 RESULT', 3)
    await say(owner, 'PRIVATE OWNER ANSWER', 4)
    await endTurn(owner)

    for (const ended of ends) {
      await expect(ended).resolves.toEqual({ unavailable: 'shared' })
      expect(await postsFor(await ended)).toEqual([])
    }
  })

  it("waits while its handoff into a running turn is unanswered, and never takes that turn's answer", async () => {
    const owner = await ownerTurn()
    let reads = 0
    const watch = watchBotTurnEnds({
      subscribeTurnCompletions: rig.host.subscribeTurnCompletions.bind(rig.host),
      subscribe: rig.host.subscribe.bind(rig.host),
      history: rig.host.history.bind(rig.host),
      currentWork: rig.host.currentWork.bind(rig.host),
      journalReads: async (sessionId) => {
        const journal = await rig.host.journalReads(sessionId)
        return {
          ...journal,
          operationWindow: async (anchors) => {
            const window = await journal.operationWindow(anchors)
            reads += 1
            return window
          }
        }
      }
    })
    const run = await sendRun('Investigate alert')
    const ended = watch.next(run)
    let settled = false
    const settle = () => {
      settled = true
    }
    void ended.then(settle, settle)

    const steer = await sentNow(run, owner)
    await endTurn(owner, { answer: 'OWNER ANSWER BEFORE RUN ACCEPTANCE' })
    const before = reads
    await eventually(() => expect(reads).toBeGreaterThan(before))
    // The read that saw the owner's turn end is done; a result from it would have settled the run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    await rig.settleRejected(steer, 'The turn had ended.')
    await expect(ended).resolves.toEqual({ outcome: 'failure', message: '' })
    expect(await postsFor(await ended)).toEqual([])
  })

  it('reports as soon as its own turn ends, while a later queued run still works', async () => {
    const owner = await ownerTurn()
    const firstWatch = watchBotTurnEnds(rig.host)
    const first = await sendRun('Investigate alert 1')
    const second = await sendRun('Investigate alert 2')
    const firstEnd = firstWatch.next(first)

    await endTurn(owner)
    const firstTurn = await handedOver(first)
    await openTurn(firstTurn)
    await endTurn(firstTurn, { answer: 'Alert 1 is a flaky test.' })
    // The next card goes at once, so the host announces no turn end until the queue drains.
    await handedOver(second)

    await expect(firstEnd).resolves.toEqual({
      outcome: 'success',
      message: 'Alert 1 is a flaky test.'
    })
  })

  it("reports its own turn's cancellation, not the owner's answer", async () => {
    const owner = await ownerTurn()
    const watch = watchBotTurnEnds(rig.host)
    const run = await sendRun('Investigate alert')
    const ended = watch.next(run)

    await endTurn(owner, { answer: "The owner's answer." })
    const turn = await handedOver(run)
    await openTurn(turn)
    await endTurn(turn, { outcome: 'cancellation' })

    await expect(ended).resolves.toEqual({ outcome: 'cancellation', message: '' })
  })
})
