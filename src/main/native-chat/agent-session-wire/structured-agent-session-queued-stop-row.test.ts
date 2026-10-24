import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalAnsweredTurnIdentity } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'

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

async function expectHeld(reason: string | null, ...draftIds: string[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(250)
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual(reason === null ? null : { reason })
}

async function mailTurn(): Promise<string> {
  const mail = rig.send('coordinator mail')
  await mail.result
  await eventually(async () => expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined())
  return mail.id
}

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

async function drawn(clientMessageId: string) {
  const { items, submissions } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
  const message = projectStructuredAgentSessionMessages(items, [], submissions).find(
    (entry) => entry.id === agentJournalSubmissionKey(clientMessageId)
  )
  return message ? { stoppedBeforeStart: message.stoppedBeforeStart } : null
}

function pauseTables(): number {
  const db = new Database(journalDatabasePath(rig.root), { readonly: true })
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%pause%'")
      .all().length
  } finally {
    db.close()
  }
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

  it('over an EMPTY queue holds nothing: a card queued during a later mail turn sends normally', async () => {
    const working = await rig.workingSend()
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const mail = await mailTurn()
    const typed = await queuedDraft('typed during the mail turn')
    expect(await rig.queuePause()).toBeNull()
    await rig.settleAccepted(mail, 'mail')
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
  })

  it('a card queued after the Stop waits behind the cards it holds, then all send in order', async () => {
    const working = await rig.workingSend()
    const held = await queuedDraft('queued before the stop')
    await rig.stop()
    const later = await queuedDraft('typed while the stopped turn winds down')
    await rig.settleAccepted(working, 'stopped')
    await expectHeld('stopped', held, later)
    expect(await rig.drafts()).toEqual([
      { messageId: held, state: 'waiting' },
      { messageId: later, state: 'waiting' }
    ])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
    expect(await rig.handoff(later)).toBeUndefined()
    await eventually(async () => expect((await rig.handoff(held))?.handedOverAt).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(held), 'held')
    await eventually(async () => expect(await rig.handoff(later)).toBeDefined())
  })

  it("any accepted turn sent after it lifts it, Orca's own mail included; a later Stop supersedes", async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    await expectHeld('stopped', first)
    const person = rig.send('the person asks for a turn')
    await person.result
    // A later Stop cannot be lifted by an earlier send.
    await rig.stop()
    await rig.settleAccepted(person.id, 'person')
    await expectHeld('stopped', first)
    const mail = await mailTurn()
    await expectHeld(null, first)
    await rig.settleAccepted(mail, 'mail')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
  })

  it('a card handed over and stopped before the agent confirms it reads as sent, never sent again; only the cards behind it send', async () => {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const steered = await queuedDraft('sent now into the turn')
    const opening = await queuedDraft('opens its own turn')
    const last = await queuedDraft('waiting behind them')
    await rig.sendNow(steered)
    await eventually(async () => expect((await rig.handoff(steered))?.handedOverAt).toBeDefined())
    const steer = await rig.handoffId(steered)
    // Codex may have received the steer despite ending its turn; no non-delivery proof exists.
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
    await rig.settleAccepted(working, 'stopped')
    await openRigTurnFor(rig, working, 'interrupted')
    await expectHeld('stopped', opening, last)
    expect(await rig.drafts()).toEqual([
      { messageId: opening, state: 'waiting' },
      { messageId: last, state: 'waiting' }
    ])
    expect(await send(steer)).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(await drawn(steer)).toEqual({ stoppedBeforeStart: undefined })

    // Stop after handover but before turn-open leaves delivery unconfirmed.
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect((await rig.handoff(opening))?.handedOverAt).toBeDefined())
    const opener = await rig.handoffId(opening)
    await rig.stop()
    await withdraw(opener)
    await expectHeld('stopped', last)
    expect(await rig.drafts()).toEqual([{ messageId: last, state: 'waiting' }])
    expect(await send(opener)).toMatchObject({ dispatchState: 'rejected' })
    expect(await drawn(opener)).toEqual({ stoppedBeforeStart: true })

    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(last)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(last), 'last')
    expect([await rig.handoffId(steered), (await send(opener))?.dispatchState]).toEqual([
      steer,
      'rejected'
    ])
    await rig.restartHostProcess()
    await rig.queuePause()
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).not.toContain('restarted')
  })

  it('survives a host crash, unshown: the next open marks the hand-off unknown, nothing sends, Resume releases', async () => {
    await openRigTurnFor(rig, await rig.workingSend())
    const sentId = await queuedDraft('sent now into the turn')
    const waiting = await queuedDraft('waiting behind it')
    await rig.sendNow(sentId)
    await eventually(async () => expect((await rig.handoff(sentId))?.handedOverAt).toBeDefined())
    await rig.stop()
    rig.crashRestartHostProcess()
    expect((await rig.handoff(sentId))?.dispatchState).toBe('unknown')
    await expectHeld(null, waiting)
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toEqual([
      'stopped',
      'restarted'
    ])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(waiting)).toBeDefined())
  })
})

describe("a restart's hold over a card queued after a Stop", () => {
  it('a card queued after a Stop over an empty queue, before a restart, waits unshown', async () => {
    const working = await rig.workingSend()
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const mail = await mailTurn()
    const typed = await queuedDraft('typed during the mail turn')
    rig.crashRestartHostProcess()
    await rig.settleAccepted(mail, 'mail')
    // Post-Stop cards are held only by restart, whose pause is unpublished.
    await rig.queuePause()
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toEqual([
      'stopped',
      'restarted'
    ])
    await expectHeld(null, typed)
  })

  it("a card queued during the queue's own send after a Stop, before a restart, waits unshown", async () => {
    const working = await rig.workingSend()
    await rig.stop()
    const correction = await queuedDraft('typed while the interrupt lands')
    await rig.settleAccepted(working, 'stopped')
    await eventually(async () =>
      expect((await rig.handoff(correction))?.handedOverAt).toBeDefined()
    )
    const typed = await queuedDraft('typed during that send')
    rig.crashRestartHostProcess()
    await rig.settleAccepted(await rig.handoffId(correction), 'correction')
    await rig.queuePause()
    expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toEqual(['restarted'])
    await expectHeld(null, typed)
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
    expect(await rig.queuePause(replacementId)).toBeNull()
    expect(structuredQueuePauses(journal(replacementId)).map((pause) => pause.reason)).toEqual([
      'stopped',
      'cleared'
    ])
    const text = hostTestMessage('hi')
    const person = rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(
        { body: text },
        'agentSession.send',
        hostTestOperationId(),
        replacementId
      ),
      body: text
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

describe('no stored pause', () => {
  it('is read or written across Stop, Resume and /clear', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('paused')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    await expectHeld('stopped', draftId)
    expect(pauseTables()).toBe(0)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    expect(pauseTables()).toBe(0)
    await eventually(async () => expect((await rig.handoff(draftId))?.handedOverAt).toBeDefined())
    await queuedDraft('carried')
    await rig.stop()
    await rig.settleAccepted(await rig.handoffId(draftId), 'drained')
    const fields = { command: 'clear' as const }
    const cleared = await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
    const replacementId = cleared.ok ? HOST_TEST_SESSION : undefined
    expect(
      replacementId && structuredQueuePauses(journal(replacementId)).map((pause) => pause.reason)
    ).toEqual(['stopped', 'cleared'])
    expect(pauseTables()).toBe(0)
  })
})
