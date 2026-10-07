// A Stop pauses the whole queue, derived from the journal: it lasts until any turn
// sent after it starts — the provider accepts it, never merely the host — or the
// person Resumes. Whoever sent that turn: a person, Orca's own mail, or the queue.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'
import {
  QUEUED_RIG_CALLER,
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { sameQueuePause } from './structured-agent-session-queued-publication'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

/** No drain step may convert the drafts, and the queue reads paused. */
async function expectPaused(...draftIds: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
}

/** The pauses in force, published or not: a restart's is never published. */
function derivedPauses(): string[] {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  return structuredQueuePauses(journal).map((pause) => pause.reason)
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** A draft behind a Stop, with the stopped turn settled so the session is idle. */
async function stoppedDraft(): Promise<string> {
  const working = await rig.workingSend()
  const draftId = await queuedDraft('paused by stop')
  await rig.stop()
  await rig.settleAccepted(working, 'stopped')
  return draftId
}

/** A queued draft handed off and handed over, found by its hand-off link. */
async function handedOver(draftId: string): Promise<void> {
  await eventually(async () => expect((await rig.handoff(draftId))?.handedOverAt).toBeDefined())
}

/** A user send the host accepted and handed over, still unanswered by the provider. */
async function handedOverUserSend(text: string): Promise<string> {
  const { id, result } = rig.send(text)
  expect(await result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
  return id
}

describe("a Stop's queue pause", () => {
  it('outlives a user send the provider accepts and then refuses; a later send that starts lifts it', async () => {
    const draftId = await stoppedDraft()
    const refused = await handedOverUserSend('the start fails')
    // On its way to lift the pause, so not shown; the refusal brings it back.
    expect(await rig.queuePause()).toBeNull()
    await rig.settleRejected(refused, 'turn/start refused')
    await expectPaused(draftId)
    const started = await handedOverUserSend('this one starts')
    await rig.settleAccepted(started, 'started')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('a Stop after the user send supersedes it: that send starting its turn lifts nothing', async () => {
    const draftId = await stoppedDraft()
    const earlier = await handedOverUserSend('sent before the second stop')
    await rig.stop()
    await rig.settleAccepted(earlier, 'late')
    await expectPaused(draftId)
  })

  it('survives a restart, and a send made after the Stop still ends it when its turn starts there', async () => {
    const draftId = await stoppedDraft()
    const inFlight = await handedOverUserSend('sent before the restart')
    // Derived from the journal, not remembered: a restart forgets nothing it needs. The process
    // dies with no close, as a quit writes no Stop event to end the pause either.
    rig.crashRestartHostProcess()
    // Still derived, though after a restart no pause is shown.
    expect(await rig.queuePause()).toBeNull()
    expect(derivedPauses()).toEqual(['stopped', 'restarted'])
    await rig.settleAccepted(inFlight, 'after-restart')
    // The Stop's pause is over; the restart's own, never shown, lasts until a turn sent since it.
    await eventually(async () => expect(derivedPauses()).toEqual(['restarted']))
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.handoff(draftId)).toBeUndefined()
    const next = rig.send('sent after the restart')
    await next.result
    await rig.settleAccepted(next.id, 'next')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it("a draft typed while the stopped turn winds down waits with the rest: the pause is the queue's", async () => {
    const working = await rig.workingSend()
    const olderId = await queuedDraft('paused by the stop')
    await rig.stop()
    const typedId = await queuedDraft('typed while stopping')
    await rig.settleAccepted(working, 'stopped')
    await expectPaused(olderId, typedId)
    expect(await rig.drafts()).toEqual([
      { messageId: olderId, state: 'waiting' },
      { messageId: typedId, state: 'waiting' }
    ])
  })

  it('Send-now sends only its own card; the rest stay paused until that turn starts, then drain after it', async () => {
    const working = await rig.workingSend()
    const sentId = await queuedDraft('sent now')
    const heldId = await queuedDraft('held until that turn starts')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.sendNow(sentId)).toMatchObject({
      ok: true,
      value: { submission: { queuedMessageId: sentId } }
    })
    await handedOver(sentId)
    // Only the card the user asked for went: the queue is still paused, though not shown while
    // that turn is on its way.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(heldId)).toBeUndefined()
    expect(derivedPauses()).toEqual(['stopped'])
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.drafts()).toEqual([{ messageId: heldId, state: 'waiting' }])
    // A turn sent after the Stop has now started, which ends the pause.
    await rig.settleAccepted(await rig.handoffId(sentId), 'sent-now')
    await eventually(async () => expect(await rig.handoff(heldId)).toBeDefined())
  })

  it('a card sent now that the provider refuses lifts nothing', async () => {
    const working = await rig.workingSend()
    // Ahead of the refused card, so its return blocks nothing Resume would send.
    const heldId = await queuedDraft('held by the stop')
    const sentId = await queuedDraft('sent now, refused')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    await rig.sendNow(sentId)
    await handedOver(sentId)
    await rig.settleRejected(await rig.handoffId(sentId), 'turn/start refused')
    await expectPaused(heldId)
  })

  it('an old send answered again after its ledger row is gone lifts nothing from a later Stop', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('paused by stop')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    // The ledger forgot the id, so the send runs again and answers with its accepted submission.
    const operations = rig.store['transactions'].state.operations
    for (const [key, row] of operations) {
      if (row.operationId === working) {
        operations.delete(key)
      }
    }
    const body = hostTestMessage('work on this')
    const replayed = await rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ body }, 'agentSession.send', working),
      body
    })
    expect(replayed).toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })
    // A later journal commit re-derives the pause; the old send was accepted before the Stop.
    rig
      .providerEvents()
      .appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'turn-later', ordinal: 901 },
        { kind: 'turn', turnId: 'turn-later', state: 'completed', startedAt: 1 },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await expectPaused(draftId)
  })
})

describe('the pause read', () => {
  it('costs no scan of the submissions: the reducer keeps the latest accepted turn', async () => {
    const draftId = await stoppedDraft()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    const scan = vi.spyOn(journal, 'submissions')
    // Read on every publish, per subscriber: it must not walk the submissions.
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    expect(scan).not.toHaveBeenCalled()
    scan.mockRestore()
    const mail = rig.send('coordinator mail')
    await mail.result
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    // Orca's own turn, accepted after the Stop, lifts it like a person's.
    await rig.settleAccepted(mail.id, 'mail')
    expect(structuredQueuePauses(journal)).toEqual([])
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })
})

describe('a card queued after a Stop is a new instruction', () => {
  it('a correction typed after a Stop over an empty queue sends when the stopped turn ends', async () => {
    const working = await rig.workingSend()
    await rig.stop()
    const correction = await queuedDraft('typed right after the stop')
    await rig.settleAccepted(working, 'stopped')
    await eventually(async () => expect(await rig.handoff(correction)).toBeDefined())
  })

  it('a card sent now before the Stop and taken anyway lifts nothing, and holds nothing typed later', async () => {
    const working = await rig.workingSend()
    await openRigTurnFor(rig, working)
    const sentId = await queuedDraft('sent now into the turn')
    await rig.sendNow(sentId)
    await handedOver(sentId)
    await rig.stop()
    // Nothing waits, so nothing is published; the pause is still derived.
    expect(await rig.queuePause()).toBeNull()
    await rig.settleAccepted(await rig.handoffId(sentId), 'sent-now')
    await rig.settleAccepted(working, 'stopped')
    await openRigTurnFor(rig, working, 'interrupted')
    const mail = rig.send('coordinator mail')
    await mail.result
    await eventually(async () =>
      expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined()
    )
    const later = await queuedDraft('typed during the mail turn')
    await rig.settleAccepted(mail.id, 'mail')
    await eventually(async () => expect(await rig.handoff(later)).toBeDefined())
    // The mail's turn, sent after the Stop, ended it.
    expect(derivedPauses()).toEqual([])
  })

  it("deleting the last paused card hides the pause; a person's next turn is what ends it", async () => {
    const working = await rig.workingSend()
    const only = await queuedDraft('paused, then deleted')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.deleteQueued(only)).toMatchObject({ ok: true, value: { deleted: true } })
    expect(await rig.queuePause()).toBeNull()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    // Hidden, not ended: with nothing to hold, no card can show the lift, so read the Stop itself.
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    const next = await rig.workingSend()
    const later = await queuedDraft('typed during the next turn')
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    // That send is a person's turn after the Stop: once it starts, the Stop is over.
    await rig.settleAccepted(next, 'next')
    expect(structuredQueuePauses(journal)).toEqual([])
    await eventually(async () => expect(await rig.handoff(later)).toBeDefined())
  })
})

describe('a pause only over cards Resume could send', () => {
  it('a Stop that leaves only a returned card publishes no pause', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('refused before the stop')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await rig.settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'returned' }])
    )
    // A lone returned card traps nothing: this send goes now, and the Stop interrupts it.
    const next = await handedOverUserSend('sent past the card')
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(next, 'stopped')
    expect(await rig.queuePause()).toBeNull()
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    expect(journal && structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
  })

  it('a returned card blocking the paused cards hides the pause but keeps it; deleting that card shows it again, and only Resume sends', async () => {
    const working = await rig.workingSend()
    const refusedId = await queuedDraft('refused after the stop')
    const behindId = await queuedDraft('waits behind the card')
    await rig.settleAccepted(working, 'a')
    await handedOver(refusedId)
    // The Stop interrupts the refused card's turn and pauses the card behind it.
    await rig.stop()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    await rig.settleRejected(await rig.handoffId(refusedId), 'provider refused this payload')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([
        { messageId: refusedId, state: 'returned' },
        { messageId: behindId, state: 'waiting' }
      ])
    )
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    // Resume would send nothing past the returned card, so no header offers it; the pause stays.
    expect(await rig.queuePause()).toBeNull()
    expect(structuredQueuePauses(journal)).toMatchObject([{ reason: 'stopped' }])
    // Deleting the blocking card shows the pause again: the card behind it does not send unasked.
    expect(await rig.deleteQueued(refusedId)).toMatchObject({ ok: true, value: { deleted: true } })
    await expectPaused(behindId)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(behindId)).toBeDefined())
  })

  it('a restart over only a card held by its own failed send publishes no pause', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('conversion fails once')
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
    try {
      await rig.settleAccepted(working, 'a')
      await eventually(async () =>
        expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting', paused: true }])
      )
    } finally {
      append.mockRestore()
    }
    await rig.restartHostProcess()
    // Only its own Send releases that card: a queue-level Resume would send nothing.
    expect(await rig.queuePause()).toBeNull()
  })

  it('compares a pause by presence before reason, so appearing or clearing is always a change', () => {
    expect(sameQueuePause(null, {})).toBe(false)
    expect(sameQueuePause({}, null)).toBe(false)
    expect(sameQueuePause(null, null)).toBe(true)
    expect(sameQueuePause({ reason: 'stopped' }, { reason: 'stopped' })).toBe(true)
    expect(sameQueuePause({ reason: 'stopped' }, { reason: 'cleared' })).toBe(false)
  })
})

describe("a restart's pause", () => {
  it('a turn ends it; closing again with a card still waiting holds that card again', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    const second = await queuedDraft('second')
    await rig.restartHostProcess()
    await rig.settleAccepted(working, 'a')
    expect(await rig.queuePause()).toBeNull()
    expect(derivedPauses()).toEqual(['restarted'])
    const next = rig.send('user starts a new turn')
    await next.result
    await rig.settleAccepted(next.id, 'b')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    // Closed again with a card still waiting, it waits again for the next turn, unshown.
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.drafts()).toContainEqual({ messageId: second, state: 'waiting' })
    expect(derivedPauses()).toEqual(['restarted'])
  })
})

describe('a card handed off after a restart', () => {
  // Returned, not waiting, when Orca restarted: the reopen holds nothing; only the Stop does.
  it('sent again and withdrawn by a Stop, it waits under that Stop alone, shown; Resume lifts it', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('refused, then re-sent after a restart')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await rig.settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'returned' }])
    )
    await rig.restartHostProcess()
    // Sent again after the restart, then withdrawn by a Stop before the agent had it.
    // Its delivery is held, so the Stop runs ahead of the handover.
    const { held, release } = holdDelivery()
    const handedOver = rig.dispatch.mock.calls.length
    const sending = rig.sendNow(draftId)
    await held
    const stopping = rig.stop()
    release()
    expect(await sending).toMatchObject({ ok: true })
    await stopping
    expect(rig.dispatch).toHaveBeenCalledTimes(handedOver)
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    )
    expect(derivedPauses()).toEqual(['stopped'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    expect(derivedPauses()).toEqual([])
  })
})

describe('Resume', () => {
  it('lifts the pause and the queue drains, oldest first; a second Resume is a no-op', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    const second = await queuedDraft('second')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    await expectPaused(first, second)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    expect(await rig.queuePause()).toBeNull()
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await rig.handoff(second)).toBeUndefined()
    // Nothing is paused now: another Resume changes nothing.
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: false } })
  })

  it('is idempotent: a replay of the same Resume answers without lifting a later pause', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('paused twice')
    await rig.stop()
    const operationId = hostTestOperationId()
    expect(await rig.resume(operationId)).toMatchObject({ ok: true, value: { resumed: true } })
    await rig.stop()
    expect(await rig.resume(operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { resumed: false }
    })
    await rig.settleAccepted(working, 'stopped')
    await expectPaused(draftId)
  })

  it("of a Stop from before a restart, which no client offers there, also lifts the restart's pause", async () => {
    const draftId = await stoppedDraft()
    rig.crashRestartHostProcess()
    expect(await rig.queuePause()).toBeNull()
    expect(derivedPauses()).toEqual(['stopped', 'restarted'])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('is a no-op on a queue that is not paused', async () => {
    await rig.workingSend()
    await queuedDraft('waiting behind the turn')
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: false } })
  })
})

describe('a failed Stop', () => {
  // Withdrawing is bookkeeping: its failure is reported, and the Stop still interrupts and pauses.
  it('still takes effect when its withdrawal fails, and pauses the queue', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('queued before the stop')
    const reject = vi
      .spyOn(AgentSessionJournal.prototype, 'rejectQueuedSubmissions')
      .mockRejectedValueOnce(new Error('disk full'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await rig.stop()).toMatchObject({ ok: true })
      expect(warned).toHaveBeenCalledWith(
        "[agent-session] stop-queued-bookkeeping: Stop's withdrawal failed",
        expect.objectContaining({ step: 'withdrawal', error: new Error('disk full') })
      )
    } finally {
      reject.mockRestore()
      warned.mockRestore()
    }
    await expectPaused(draftId)
  })

  it('keeps its pause when it fails after the interrupt reached the agent', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('paused by stop')
    const append = AgentSessionJournal.prototype.appendItem
    const failing = vi
      .spyOn(AgentSessionJournal.prototype, 'appendItem')
      .mockImplementation(async function (this: AgentSessionJournal, ...args) {
        // The status note written after the provider was asked to stop.
        if (args[1].kind === 'status') {
          throw new Error('disk full')
        }
        return append.apply(this, args)
      })
    try {
      await expect(rig.stop()).rejects.toThrow('disk full')
    } finally {
      failing.mockRestore()
    }
    await expectPaused(draftId)
  })
})
