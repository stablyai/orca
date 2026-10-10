// A Stop the host admits aborts the start the queue is waiting on, for any agent, but only once the
// Stop is saved: it is admitted outside the queue, saved, then aborts the start. The message that
// start was for is what the Stop stops, so it is withdrawn and never sends; a message sent after the
// Stop is no part of the aborted start, so it gets a start of its own rather than that start's
// refusal. A Stop that cannot be saved leaves the start alone.

import { afterEach, expect, it, vi } from 'vitest'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => {
  vi.restoreAllMocks()
  rig.dispose()
})

/** A chat whose child is gone, with `during` run once while the next send's start reconciles. */
async function duringStart(during: () => void): Promise<void> {
  rig = await createQueuedMessageTestRig({ restartable: true })
  await rig.host.close(SESSION, 'evict')
  const runtimeState = rig.host.collaboratorsForTests().runtimeState
  const probe = runtimeState.probeOwner.bind(runtimeState)
  let ran = false
  runtimeState.probeOwner = async (sessionId) => {
    if (!ran) {
      ran = true
      during()
    }
    return probe(sessionId)
  }
}

function stopEvents(): number {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  const since = journal?.readSince({ epoch: journal.epoch, sequence: 0 })
  return since?.ok
    ? since.rows.filter((row) => row.kind === 'tombstone' && row.stopEvent?.reason === 'user-stop')
        .length
    : -1
}

/** Proves a start the rig's provider holds, until `id` is handed over. */
async function untilHandedOver(id: string): Promise<void> {
  await eventually(async () => {
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
      await rig.proveStart()
    }
    expect((await rig.submission(id))?.handedOverAt).toBeDefined()
  })
}

it('starts a Codex chat afresh for a message sent right after a Stop reached its reconciling start', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  let second: ReturnType<QueuedMessageTestRig['send']> | undefined
  await duringStart(() => {
    stopping = rig.stop()
    // Accepted while the aborted start is still unwinding.
    second = rig.send('second')
  })
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(second).toBeDefined())
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  await second!.result
  await untilHandedOver(second!.id)
  // The message the start was for is what the Stop stopped: withdrawn, with no card.
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
  expect((await rig.submission(first.id))?.keptAsQueuedMessageId).toBeUndefined()
  expect(await rig.drafts()).toEqual([])
  expect((await rig.submission(second!.id))?.rejection).toBeUndefined()
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})

it('never sends the message it stopped, even after the correction the person sends next runs', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  await duringStart(() => {
    stopping = rig.stop()
  })
  const first = rig.send('hello (stopped)')
  await first.result
  await eventually(() => expect(stopping).toBeDefined())
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  const correction = rig.send('a correction')
  await correction.result
  await untilHandedOver(correction.id)
  await rig.settleAccepted(correction.id, 'correction')
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(await rig.handoff(first.id)).toBeUndefined()
  expect(await rig.drafts()).toEqual([])
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})

it('aborts the start only once it is saved, and records the Stop, not a no-op', async () => {
  const id = hostTestOperationId()
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  const eventsAtAbort: number[] = []
  await duringStart(() => {
    const aborts = rig.host.collaboratorsForTests().runtimeState.acquireAborts
    const abort = aborts.abort.bind(aborts)
    vi.spyOn(aborts, 'abort').mockImplementation((sessionId, reason) => {
      eventsAtAbort.push(stopEvents())
      return abort(sessionId, reason)
    })
    stopping = rig.stop(id)
  })
  await rig.send('hello').result
  await eventually(() => expect(stopping).toBeDefined())
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(eventsAtAbort).toEqual([1])
  expect(
    rig.store.readCommandReceipt({ kind: 'caller', callerKey: CALLER.callerKey }, id)
  ).toMatchObject({ verdict: 'readable', receipt: { result: { kind: 'journal-row' } } })
})

it('leaves the start alone when it cannot be saved: the message it was for still sends', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  vi.spyOn(JournalStopAcceptor.prototype, 'accept').mockRejectedValue(new Error('disk full'))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await duringStart(() => {
    stopping = rig.stop()
  })
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(stopping).toBeDefined())
  expect(await stopping).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'stopFailed' } }
  })
  await untilHandedOver(first.id)
  expect(stopEvents()).toBe(0)
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})
