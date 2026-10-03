// Ending a child whose start failed is not a Stop, whoever ends it: the failure is said once, on its
// messages. It writes no Stop event, so it never ends a person's Stop pause and lets a held card go.

import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

/** Swept only when a test ticks it. */
const MANUAL_IDLE_SWEEP = { idleMs: 0, intervalMs: 60 * 60 * 1000 }

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

async function stopReasons(): Promise<string[]> {
  await rig.host.flushStreamedEvents(HOST_TEST_SESSION)
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent.reason] : []
  )
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error(`expected a queued draft, got ${JSON.stringify(queued)}`)
  }
  return queued.value.queued.messageId
}

/** A person's Stop pausing a held card, with the agent then put to rest (which writes nothing). */
async function personStopHoldingACard(): Promise<string> {
  const working = await rig.workingSend()
  const held = await queuedDraft('queued behind the turn')
  expect(await rig.stop()).toMatchObject({ ok: true })
  await rig.settleAccepted(working, 'stopped')
  await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  expect(await stopReasons()).toEqual(['user-stop'])
  return held
}

describe('ending a child whose start failed', () => {
  it('writes no Stop event when the next message ends it', async () => {
    rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
    rig.awaitStarted.mockResolvedValueOnce(agentSessionFailureFact('providerStartFailed'))
    const first = rig.send('first')
    await eventually(async () =>
      expect(await rig.submission(first.id)).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(
      rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.startFailed
    ).toBe(true)

    const second = rig.send('second')

    await eventually(async () =>
      expect((await rig.submission(second.id))?.handedOverAt).toBeDefined()
    )
    expect(await stopReasons()).toEqual([])
  })

  it("keeps a person's Stop pause when a new message's start fails at its handover", async () => {
    rig = await createQueuedMessageTestRig({
      starting: true,
      restartable: true,
      idleSweep: MANUAL_IDLE_SWEEP
    })
    const held = await personStopHoldingACard()
    rig.dispatch.mockImplementation(() => {
      throw new Error('no live session')
    })

    const { id } = rig.send('a new instruction')

    await eventually(async () =>
      expect(await rig.submission(id)).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(await stopReasons()).toEqual(['user-stop'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.handoff(held)).toBeUndefined()
  })

  async function failedChildBehindAPersonsStop(): Promise<string> {
    const held = await personStopHoldingACard()
    rig.awaitStarted.mockResolvedValueOnce(agentSessionFailureFact('providerStartFailed'))
    const first = rig.send('first after stop')
    await eventually(async () =>
      expect(await rig.submission(first.id)).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child).toMatchObject({
      phase: 'starting',
      startFailed: true
    })
    return held
  }

  it("keeps a person's Stop pause when the next message ends a failed child", async () => {
    rig = await createQueuedMessageTestRig({
      starting: true,
      restartable: true,
      idleSweep: MANUAL_IDLE_SWEEP
    })
    const held = await failedChildBehindAPersonsStop()

    const second = rig.send('second after stop')

    await eventually(async () =>
      expect((await rig.submission(second.id))?.handedOverAt).toBeDefined()
    )
    expect(await stopReasons()).toEqual(['user-stop'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.handoff(held)).toBeUndefined()
  })

  it("keeps a person's Stop pause when the idle sweep ends a failed child", async () => {
    rig = await createQueuedMessageTestRig({
      starting: true,
      restartable: true,
      idleSweep: MANUAL_IDLE_SWEEP
    })
    const held = await failedChildBehindAPersonsStop()
    const closes = rig.closeSession.mock.calls.length

    await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()

    expect(rig.closeSession.mock.calls.length).toBeGreaterThan(closes)
    expect(await stopReasons()).toEqual(['user-stop'])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.handoff(held)).toBeUndefined()
  })
})
