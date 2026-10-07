// A Stop the host admits aborts the start the queue is waiting on, for any agent: the host checks
// the start's signal before it asks the adapter. A message sent after that Stop is no part of the
// aborted start, so it gets a start of its own rather than that start's refusal.

import { afterEach, expect, it } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

it('starts a Codex chat afresh for a message sent right after a Stop reached its reconciling start', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  // The chat's child is gone; the next send has to start one.
  await rig.host.close(SESSION, 'evict')
  const runtimeState = rig.host.collaboratorsForTests().runtimeState
  const probe = runtimeState.probeOwner.bind(runtimeState)
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  let second: ReturnType<QueuedMessageTestRig['send']> | undefined
  runtimeState.probeOwner = async (sessionId) => {
    if (!stopping) {
      stopping = rig.stop()
      // Accepted while the aborted start is still unwinding.
      second = rig.send('second')
    }
    return probe(sessionId)
  }
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(second).toBeDefined())
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  await second!.result
  await eventually(async () =>
    expect((await rig.submission(second!.id))?.handedOverAt).toBeDefined()
  )
  expect((await rig.submission(first.id))?.rejection).toMatchObject({ kind: 'cancelled' })
  expect((await rig.submission(second!.id))?.rejection).toBeUndefined()
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})
