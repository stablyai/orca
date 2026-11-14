import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalAnsweredTurnIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { structuredQueuePauses } from '../../delivery/structured-agent-session-queued-pause'
// The host records Stop before interrupting; only accepted person work or Resume lifts its hold.

let rig: QueuedMessageTestRig

beforeEach(async () => {
  vi.useFakeTimers()
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(async () => {
  try {
    await rig.dispose()
  } finally {
    vi.useRealTimers()
  }
})

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

function journal(sessionId = HOST_TEST_SESSION) {
  const open = rig.host.collaboratorsForTests().sessions.get(sessionId)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** No drain step converts the cards, and the published pause names `reason` (null: none shown). */
async function expectHeld(reason: string | null, ...draftIds: string[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(250)
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual(reason === null ? null : { reason })
}

/** A Stop's withdrawal as the provider writes it, naming the turn it was answered into if any. */
function withdraw(clientMessageId: string, answeredInTurn?: AgentJournalAnsweredTurnIdentity) {
  return rig.host.settleLateDispatch({
    sessionId: HOST_TEST_SESSION,
    clientMessageId,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
    ...(answeredInTurn ? { answeredInTurn } : {})
  })
}

async function send(clientMessageId: string) {
  return (await rig.host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

/** How the shared projection every client runs draws this send, or null when it hides it. */
async function drawn(clientMessageId: string) {
  const { items, submissions } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
  const message = projectStructuredAgentSessionMessages(items, [], submissions).find(
    (entry) => entry.id === agentJournalSubmissionKey(clientMessageId)
  )
  return message ? { stoppedBeforeStart: message.stoppedBeforeStart } : null
}

describe("Stop's event", () => {
  it('is written before the interrupt reaches the agent', async () => {
    await rig.workingSend()
    let pausedAtInterrupt: unknown = 'not interrupted'
    rig.cancelTurn.mockImplementationOnce(async () => {
      pausedAtInterrupt = structuredQueuePauses(journal())[0]?.reason ?? null
      return { cancelled: true }
    })
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(pausedAtInterrupt).toBe('stopped')
  })

  it('keeps personal rows and their Stop visible while mail is pending and accepted', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('held personal work')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const mail = rig.send('coordinator mail', undefined, {
      internal: true,
      from: {
        kind: 'agent',
        senders: [
          {
            party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
            name: null
          }
        ],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'agent:worker',
          dispatchId: null,
          messages: []
        }
      }
    })
    await mail.result
    await expectHeld('stopped', first)
    await rig.settleAccepted(mail.id, 'mail')
    await expectHeld('stopped', first)
    const person = rig.send('resume my work')
    await person.result
    await rig.settleAccepted(person.id, 'person')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
  })

  it('a stopped unconfirmed hand-off stays ordinary while Resume drains waiting cards', async () => {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    await rig.settleAccepted(working, 'stopped')
    const steered = await queuedDraft('sent now into the turn')
    const opening = await queuedDraft('opens its own turn')
    const last = await queuedDraft('waiting behind them')
    expect(await rig.sendNow(steered)).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(steered))?.handedOverAt).toBeDefined())
    const steer = await rig.handoffId(steered)
    // Codex ends the stopped turn without taking the steer: the agent may have it, nothing proves
    // it did not.
    await rig.stop()
    await withdraw(steer, {
      turn: {
        provider: 'codex',
        threadId: HOST_TEST_THREAD,
        turnId: `turn-of-${working}`,
        ordinal: 0
      },
      via: 'steer'
    })
    await openRigTurnFor(rig, working, 'interrupted')
    await expectHeld('stopped', opening, last)
    expect(await rig.drafts()).toEqual([
      { messageId: opening, state: 'waiting' },
      { messageId: last, state: 'waiting' }
    ])
    expect(journal().submissionBody(steer)).toEqual(hostTestMessage('sent now into the turn'))
    expect(journal().queuedMessages.get(`recovery:${steer}`)).toBeNull()
    expect(journal().submission(steer)?.options).toEqual({})
    // The turn's message, unconfirmed, as an old client's projection draws it too.
    expect(await send(steer)).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(await drawn(steer)).toEqual({ stoppedBeforeStart: undefined })

    expect(await rig.deleteQueued(`recovery:${steer}`)).toMatchObject({ value: { deleted: false } })
    await expectHeld('stopped', opening, last)
    // Resume hands the next card over; an explicit refusal before it opens is still a rejection.
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect((await rig.handoff(opening))?.handedOverAt).toBeDefined())
    const opener = await rig.handoffId(opening)
    await rig.stop()
    await withdraw(opener)
    await expectHeld('stopped', last)
    expect(await rig.drafts()).toEqual([{ messageId: last, state: 'waiting' }])
    // Drawn as a person's own send a Stop took back.
    expect(await send(opener)).toMatchObject({ dispatchState: 'rejected' })
    expect(await drawn(opener)).toEqual({ stoppedBeforeStart: true })

    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(last)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(last), 'last')
    expect([await rig.handoffId(steered), (await send(opener))?.dispatchState]).toEqual([
      steer,
      'rejected'
    ])
    // Neither stopped card can come back, so a reopen holds nothing.
    await rig.restartHostProcess()
    await rig.queuePause()
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).not.toContain('restarted')
  })

  it('survives a host crash: Resume releases waiting work without resending the uncertain original', async () => {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    await rig.settleAccepted(working, 'received')
    const sentId = await queuedDraft('sent now into the turn')
    const waiting = await queuedDraft('waiting behind it')
    await rig.sendNow(sentId)
    await eventually(async () => expect((await rig.handoff(sentId))?.handedOverAt).toBeDefined())
    await rig.stop()
    // Drain this process's in-flight writes before replacing its in-process fixture owner.
    await rig.host.flushAllStreamedEvents()
    rig.crashRestartHostProcess()
    expect((await rig.handoff(sentId))?.dispatchState).toBe('unknown')
    // The ordinary original never becomes queued work or resends automatically.
    await expectHeld(null, waiting)
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toEqual([
      'stopped',
      'restarted'
    ])
    const handoff = await rig.handoffId(sentId)
    expect(await rig.drafts()).toEqual([{ messageId: waiting, state: 'waiting' }])
    expect(journal().submissionBody(handoff)).toEqual(hostTestMessage('sent now into the turn'))
    expect(await rig.deleteQueued(`recovery:${handoff}`)).toMatchObject({
      value: { deleted: false }
    })
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(waiting)).toBeDefined())
  })
})

describe("a /clear's carried cards", () => {
  function clear() {
    const fields = { command: 'clear' as const }
    return rig.host.conversationCommand(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
  }

  it("wait 'cleared' on the replacement until a turn there", async () => {
    const working = await rig.workingSend()
    const carried = await queuedDraft('written for the old context')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const cleared = await clear()
    const replacementId = cleared.ok ? HOST_TEST_SESSION : undefined
    if (!replacementId) {
      throw new Error(`expected clear to succeed: ${JSON.stringify(cleared)}`)
    }
    // Held there, unshown: nothing runs in the fresh conversation.
    expect(await rig.queuePause(replacementId)).toBeNull()
    expect(structuredQueuePauses(journal(replacementId)).map((pause) => pause.reason)).toEqual([
      'stopped',
      'cleared'
    ])
    // Idle there, so the person's send goes straight out rather than queueing.
    const text = hostTestMessage('hi')
    const person = rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(
        { body: text },
        'agentSession.send',
        hostTestOperationId(),
        replacementId
      ),
      body: text,
      userSend: true
    })
    const sent = await person
    if (!sent.ok || !('submission' in sent.value)) {
      throw new Error(`expected an immediate send: ${JSON.stringify(sent)}`)
    }
    await eventually(async () =>
      expect(
        (await rig.host.journalSnapshot(replacementId)).submissions.find(
          (entry) => entry.clientMessageId === sent.value.clientMessageId
        )?.handedOverAt
      ).toBeDefined()
    )
    await rig.host.settleLateDispatch({
      sessionId: replacementId,
      clientMessageId: sent.value.clientMessageId,
      providerIdentity: {
        provider: 'codex',
        threadId: rig.store.getRecord(replacementId)!.providerHandleChain.at(-1)!.handle.nativeId,
        turnId: 'turn-hi',
        ordinal: 0
      }
    })
    expect(journal(replacementId).queuedMessages.list()[0]?.messageId).toBe(carried)
    expect(structuredQueuePauses(journal(replacementId))).toEqual([])
  })
})
