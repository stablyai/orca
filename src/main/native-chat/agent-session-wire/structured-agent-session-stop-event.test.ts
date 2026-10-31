import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

let rig: QueuedMessageTestRig
const observationClock = createStructuredSessionObservationClock(() => rig.host, HOST_TEST_SESSION)
beforeEach(() => observationClock.start())

afterEach(async () => {
  await observationClock.restoreBeforeCleanup(() => rig.dispose())
})

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function stopEvents(): JournalStopEvent[] {
  const mark = journal().stopMarks.latest()
  return mark ? [mark.event] : []
}

async function turnRow(turnId: string, state: 'running' | 'interrupted', userId?: string) {
  return journal().appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 },
    {
      kind: 'turn',
      turnId,
      state,
      startedAt: 1,
      ...(userId ? { userItemId: agentJournalSubmissionKey(userId) } : {})
    },
    {
      fence: rig.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

describe("a Stop's event", () => {
  it('publishes the request note while the native interrupt is still unanswered', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    const interrupt = Promise.withResolvers<{ cancelled: boolean }>()
    rig.cancelTurn.mockImplementationOnce(() => interrupt.promise)
    const stopped = rig.stop()
    try {
      await eventually(() =>
        expect(
          journal()
            .snapshot()
            .items.filter(
              (item) => item.body.kind === 'status' && item.body.text === 'Cancellation requested.'
            )
        ).toHaveLength(1)
      )
      expect(rig.cancelTurn).toHaveBeenCalledOnce()
    } finally {
      interrupt.resolve({ cancelled: true })
      await stopped
    }
    expect(
      journal()
        .snapshot()
        .items.filter(
          (item) => item.body.kind === 'status' && item.body.text === 'Cancellation requested.'
        )
    ).toHaveLength(1)
  })

  it('reaches the journal before the interrupt, naming the turn it stopped and who asked', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    await turnRow('turn-1', 'running')
    let atInterrupt: JournalStopEvent[] = []
    rig.cancelTurn.mockImplementationOnce(async () => {
      atInterrupt = stopEvents()
      return { cancelled: true }
    })
    const fields = { turnId: 'turn-1' }
    const operationId = hostTestOperationId()
    const stopped = await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.cancel', operationId),
      ...fields
    })
    expect(stopped).toMatchObject({ ok: true })
    expect(rig.cancelTurn).toHaveBeenCalledTimes(1)
    expect(atInterrupt).toEqual([
      {
        reason: 'user-stop',
        turnId: 'turn-1',
        caller: QUEUED_RIG_CALLER.callerKey,
        at: expect.any(Number)
      }
    ])
  })
})
