// A Stop's event, through the real host: written in the Stop's serialized step once it takes
// effect, before the interrupt and before anything that ends the child, naming the turn and who
// asked; never by a Stop that stopped nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** Every Stop event in the live epoch, oldest first. */
function stopEvents(): JournalStopEvent[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent] : []
  )
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error(`expected a queued receipt: ${JSON.stringify(queued)}`)
  }
  return queued.value.queued.messageId
}

/** The provider's turn row for the working send, which may land after a Stop. */
async function turnRow(turnId: string, state: 'running' | 'interrupted') {
  return journal().appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 },
    { kind: 'turn', turnId, state, startedAt: 1 },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** Held by the one Stop once its turn ends, then sent by Resume. */
async function expectReleasedByResume(draftId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(await rig.handoff(draftId)).toBeUndefined()
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
}

function withdraw(clientMessageId: string) {
  return rig.host.settleLateDispatch({
    sessionId: HOST_TEST_SESSION,
    clientMessageId,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  })
}

/** Holds every start until the returned release. */
function holdStart(): () => void {
  let release: () => void = () => undefined
  rig.awaitStarted.mockImplementation(
    () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
  )
  return () => release()
}

describe("a Stop's event", () => {
  it('reaches the journal before the interrupt, naming the turn it stopped and who asked', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    let atInterrupt: JournalStopEvent[] = []
    rig.cancelTurn.mockImplementationOnce(async () => {
      atInterrupt = stopEvents()
      return { cancelled: true }
    })
    const fields = { turnId: 'turn-named' }
    const stopped = await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId()),
      ...fields
    })
    expect(stopped).toMatchObject({ ok: true })
    expect(rig.cancelTurn).toHaveBeenCalledTimes(1)
    expect(atInterrupt).toEqual([
      {
        reason: 'user-stop',
        turnId: 'turn-named',
        caller: QUEUED_RIG_CALLER.callerKey,
        at: expect.any(Number)
      }
    ])
  })

  it("lands before the rows the interrupt causes: the stopped turn's end comes after it", async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    let turnEnd: number | undefined
    rig.cancelTurn.mockImplementationOnce(async () => {
      // As a provider answers an interrupt: the stopped turn's end, journaled before it returns.
      turnEnd = (await turnRow('turn-1', 'interrupted')).cursor.sequence
      return { cancelled: true }
    })
    await rig.stop()
    const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
    const stopRow = since.ok
      ? since.rows.find((row) => row.kind === 'tombstone' && row.stopEvent)
      : undefined
    expect(stopRow?.seq).toBeLessThan(turnEnd ?? 0)
  })

  it('a write that throws before it is queued is reported, and the Stop still interrupts', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(journal(), 'appendStopEvent').mockImplementation(() => {
      throw new Error('the journal threw')
    })
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(rig.cancelTurn).toHaveBeenCalledTimes(1)
    expect(warned).toHaveBeenCalledWith(
      "[agent-session] stop-queued-bookkeeping: Stop's event row failed",
      expect.objectContaining({ step: 'event row', error: new Error('the journal threw') })
    )
    warned.mockRestore()
  })

  it('at an agent still starting, reaches the journal before the start is ended, and holds a card queued before it', async () => {
    rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
    const release = holdStart()
    rig.send('work on this')
    const held = await queuedDraft('queued while it starts')
    let atEnd: JournalStopEvent[] | undefined
    rig.closeSession.mockImplementationOnce(async () => {
      atEnd = stopEvents()
      return true
    })
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    release()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(held)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(rig.closeSession).toHaveBeenCalledTimes(1)
    expect(atEnd).toEqual([
      { reason: 'user-stop', caller: QUEUED_RIG_CALLER.callerKey, at: expect.any(Number) }
    ])
  })

  it('is written by an idle Stop only when it withdrew a send', async () => {
    rig = await createQueuedMessageTestRig()
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(stopEvents()).toEqual([])
    const release = holdStart()
    const waiting = rig.send('waits for the start')
    await eventually(async () => expect(await rig.submission(waiting.id)).toBeDefined())
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    release()
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(stopEvents()).toEqual([
      { reason: 'user-stop', caller: QUEUED_RIG_CALLER.callerKey, at: expect.any(Number) }
    ])
  })

  it('a second press while the first interrupt lands writes nothing: a card queued between them waits as after one Stop', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    const between = await queuedDraft('queued between the presses')
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(stopEvents()).toHaveLength(1)
    await rig.settleAccepted(working, 'stopped')
    await expectReleasedByResume(between)
  })

  it('a second press once the turn shows, after a first before it did, writes nothing: a card queued between waits', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    await rig.stop()
    const between = await queuedDraft('queued between the presses')
    await turnRow('turn-1', 'running')
    await rig.stop()
    expect(stopEvents()).toHaveLength(1)
    await rig.settleAccepted(working, 'stopped')
    await turnRow('turn-1', 'interrupted')
    await expectReleasedByResume(between)
  })

  it('a second press after a card sent into the turn settled unknown writes again', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    await rig.stop()
    const steered = await queuedDraft('sent into the turn between the presses')
    await rig.sendNow(steered)
    await eventually(async () => expect((await rig.handoff(steered))?.handedOverAt).toBeDefined())
    await rig.host.settleLateDispatch({
      sessionId: HOST_TEST_SESSION,
      clientMessageId: await rig.handoffId(steered),
      state: 'unknown',
      reason: 'the provider never answered'
    })
    await rig.stop()
    expect(stopEvents()).toHaveLength(2)
  })

  it('a second press after a card was sent into the turn writes again, and holds that card', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    await rig.stop()
    const steered = await queuedDraft('sent into the turn between the presses')
    await rig.sendNow(steered)
    await eventually(async () => expect((await rig.handoff(steered))?.handedOverAt).toBeDefined())
    await rig.stop()
    expect(stopEvents()).toHaveLength(2)
    await withdraw(await rig.handoffId(steered))
    await rig.settleAccepted(working, 'stopped')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.drafts()).toEqual([{ messageId: steered, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it('naming no turn, names the turn running when it takes effect', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    await turnRow('turn-1', 'running')
    await rig.stop()
    expect(stopEvents()).toMatchObject([{ reason: 'user-stop', turnId: 'turn-1' }])
  })

  it('names a turn already over, as a late Stop from a phone does: writes nothing', async () => {
    rig = await createQueuedMessageTestRig()
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false })
    const fields = { turnId: 'turn-already-over' }
    const stopped = await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId()),
      ...fields
    })
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(stopEvents()).toEqual([])
  })

  it('names a turn that ended while the next card is sent but shows no turn yet: writes, and holds that card', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    await turnRow('turn-1', 'running')
    const next = await queuedDraft('sent when turn-1 ends')
    await rig.settleAccepted(working, 'working')
    await turnRow('turn-1', 'interrupted')
    await eventually(async () => expect((await rig.handoff(next))?.handedOverAt).toBeDefined())
    expect(journal().activeTurnId()).toBeNull()
    const fields = { turnId: 'turn-1' }
    await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId()),
      ...fields
    })
    expect(stopEvents()).toHaveLength(1)
    await withdraw(await rig.handoffId(next))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.drafts()).toEqual([{ messageId: next, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it("holds a card when it lands between the queue's pick and its claim", async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    const draftId = await queuedDraft('picked by the drain')
    const open = journal()
    const appendSubmission = open.appendSubmission.bind(open)
    let injected = false
    // Stop and the drain share one serialized lane, so this interleaving is forced: a pause
    // written after the drain chose the card must still hold it in the claim's transaction.
    vi.spyOn(open, 'appendSubmission').mockImplementation(async (input, consume) => {
      // The queue's own claim is the one no operation settles.
      if (consume?.settledByOp === null && consume.messageId === draftId && !injected) {
        injected = true
        await open.appendStopEvent({ reason: 'user-stop' }, input.fence)
      }
      return appendSubmission(input, consume)
    })
    await rig.settleAccepted(working, 'working')
    await eventually(() => expect(injected).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })
})
