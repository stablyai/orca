// Stop writes one event row before it interrupts, and the queue's pause is derived from it:
// through the real host, the cards queued before a Stop wait, a card queued after it sends
// normally but never ahead of them, a withdrawn card comes back under it, a crash keeps it, it
// never hides a restart's pause, and no stored pause is ever written.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

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

/** No drain step converts the cards, and the published pause names `reason`. */
async function expectHeld(reason: string, ...draftIds: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual({ reason })
}

async function mailTurn(): Promise<string> {
  const mail = rig.send('coordinator mail', undefined, { internal: true })
  await mail.result
  await eventually(async () => expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined())
  return mail.id
}

function withdraw(clientMessageId: string) {
  return rig.host.settleLateDispatch({
    sessionId: HOST_TEST_SESSION,
    clientMessageId,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  })
}

/** Tables that could store a pause: none, the journal rows are the only record. */
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
    await rig.settleAccepted(working, 'stopped')
    const mail = await mailTurn()
    const later = await queuedDraft('queued during the mail turn')
    await rig.settleAccepted(mail, 'mail')
    // The queue never reorders: the newer card waits behind the held one, with no caption of its own.
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

  it("a person's accepted turn lifts it; a host turn and a later Stop do not", async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    await rig.settleAccepted(await mailTurn(), 'mail')
    await expectHeld('stopped', first)
    const person = rig.send('the person asks for a turn')
    await person.result
    // A later Stop supersedes: the send made before it no longer lifts anything.
    await rig.stop()
    await rig.settleAccepted(person.id, 'person')
    await expectHeld('stopped', first)
    const after = rig.send('asked after the second Stop')
    await after.result
    await rig.settleAccepted(after.id, 'after')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
  })

  it('a card the Stop withdrew comes back once, under the pause, and is never sent again on its own', async () => {
    const working = await rig.workingSend()
    const sentId = await queuedDraft('sent now into the turn')
    await rig.sendNow(sentId)
    await eventually(async () => expect((await rig.handoff(sentId))?.handedOverAt).toBeDefined())
    const handoffId = await rig.handoffId(sentId)
    await rig.stop()
    await withdraw(handoffId)
    await withdraw(handoffId)
    await rig.settleAccepted(working, 'stopped')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.drafts()).toEqual([{ messageId: sentId, state: 'waiting' }])
    const sends = (await rig.host.journalSnapshot(HOST_TEST_SESSION)).submissions.filter(
      (entry) => entry.queuedMessageId === sentId
    )
    expect(sends.map((entry) => [entry.origin, entry.dispatchState])).toEqual([
      ['client', 'rejected']
    ])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect((await rig.handoff(sentId))?.origin).toBe('host'))
  })

  it('survives a host crash: the next open marks the hand-off unknown, the pause stays, Resume sends', async () => {
    await rig.workingSend()
    const sentId = await queuedDraft('sent now into the turn')
    const waiting = await queuedDraft('waiting behind it')
    await rig.sendNow(sentId)
    await eventually(async () => expect((await rig.handoff(sentId))?.handedOverAt).toBeDefined())
    await rig.stop()
    // The process dies with no close; a new host opens the same state directory.
    rig.crashRestartHostProcess()
    expect((await rig.handoff(sentId))?.dispatchState).toBe('unknown')
    await expectHeld('stopped', waiting)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(waiting)).toBeDefined())
  })
})

describe("a Stop never hides a restart's pause", () => {
  it('a card queued after a Stop over an empty queue, before a restart, waits restarted', async () => {
    const working = await rig.workingSend()
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const mail = await mailTurn()
    const typed = await queuedDraft('typed during the mail turn')
    await rig.restartHostProcess()
    await rig.settleAccepted(mail, 'mail')
    await expectHeld('restarted', typed)
  })

  it("a card queued during the queue's own send after a Stop, before a restart, waits restarted", async () => {
    const working = await rig.workingSend()
    await rig.stop()
    const correction = await queuedDraft('typed while the interrupt lands')
    await rig.settleAccepted(working, 'stopped')
    // The queue's own send is not a person's turn: the Stop stays in force, holding nothing.
    await eventually(async () =>
      expect((await rig.handoff(correction))?.handedOverAt).toBeDefined()
    )
    const typed = await queuedDraft('typed during that send')
    await rig.restartHostProcess()
    await rig.settleAccepted(await rig.handoffId(correction), 'correction')
    await expectHeld('restarted', typed)
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

  it("wait 'cleared' on the replacement until a person's turn there", async () => {
    const working = await rig.workingSend()
    const carried = await queuedDraft('written for the old context')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const cleared = await clear()
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error(`expected a replacement session: ${JSON.stringify(cleared)}`)
    }
    expect(await rig.queuePause(replacementId)).toEqual({ reason: 'cleared' })
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
      providerIdentity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-hi', ordinal: 0 }
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
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    expect(replacementId && (await rig.queuePause(replacementId))).toEqual({ reason: 'cleared' })
    expect(pauseTables()).toBe(0)
  })
})
