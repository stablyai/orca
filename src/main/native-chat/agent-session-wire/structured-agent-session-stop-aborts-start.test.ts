// A Stop the host admits aborts the start the queue is waiting on as it arrives, for any agent, then
// captures what is left once on the lane and saves it before acting. The message that start was for
// is withdrawn with the rest of the queue and never sends; a message sent after the Stop is no part
// of the aborted start, so it gets a start of its own rather than that start's refusal.

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
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
  expect((await rig.submission(second!.id))?.rejection).toBeUndefined()
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})

// The round-2 repro: a Stop at a start whose save is slow, while the person picks an option. The
// Stop never says it stopped an agent that runs on, and the pick never fails with the start's abort.
it('answers truthfully when the save is slow and an option pick waits behind it', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  const saving = Promise.withResolvers<void>()
  const accept = JournalStopAcceptor.prototype.accept
  vi.spyOn(JournalStopAcceptor.prototype, 'accept').mockImplementation(async function (
    this: JournalStopAcceptor,
    ...args
  ) {
    await saving.promise
    return accept.apply(this, args)
  })
  await duringStart(() => {
    stopping = rig.stop()
  })
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(stopping).toBeDefined())
  const fields = { key: 'model', value: 'gpt-next' }
  const picked = rig.host.setOption(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
    ...fields
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  saving.resolve()

  // The start ended on the Stop's arrival, so it never landed: what it was for never runs.
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child ?? null).toBeNull()
  expect(rig.dispatch).not.toHaveBeenCalled()
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
  // With no agent running, the pick is kept for the next start.
  const pick = await picked
  expect(JSON.stringify(pick)).not.toContain('stopped while starting')
  expect(pick).toMatchObject({ ok: true })
})

// What it withdrew is read as it was captured, on the lane it holds: a throw after the commit
// cannot turn the withdrawal it saved into "nothing stopped".
it('answers that it stopped the queued message even when its write throws after the commit', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  const accept = JournalStopAcceptor.prototype.accept
  vi.spyOn(JournalStopAcceptor.prototype, 'accept').mockImplementationOnce(async function (
    this: JournalStopAcceptor,
    ...args
  ) {
    await accept.apply(this, args)
    throw new Error('fold failed after commit')
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await duringStart(() => {
    stopping = rig.stop()
  })
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(stopping).toBeDefined())

  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
})
