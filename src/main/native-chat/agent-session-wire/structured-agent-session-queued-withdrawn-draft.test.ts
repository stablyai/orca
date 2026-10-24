import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

let rig: QueuedMessageTestRig
const observationClock = createStructuredSessionObservationClock(() => rig.host, SESSION)
beforeEach(() => observationClock.start())

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(async () => {
  await observationClock.restoreBeforeCleanup(() => rig.dispose())
})

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

async function submissionIds(): Promise<string[]> {
  return (await rig.host.journalSnapshot(SESSION)).submissions.map((entry) => entry.clientMessageId)
}

async function handedOver(id: string): Promise<void> {
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
}

it('Stop, then a user send: the withdrawn draft and the paused cards behind it drain one per turn, in queue order', async () => {
  const working = await rig.workingSend()
  const a = await queuedDraft('A')
  const b = await queuedDraft('B')
  const c = await queuedDraft('C')
  // Hold provider delivery after A is consumed.
  const { release } = holdDelivery()
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect(await rig.handoff(a)).toBeDefined())
  const firstA = await rig.handoffId(a)
  expect(firstA).not.toBe(a)
  expect((await rig.submission(firstA))?.handedOverAt).toBeUndefined()

  // Release the held lane so Stop runs ahead of provider handover.
  const stopped = rig.stop()
  release()
  expect(await stopped).toMatchObject({ ok: true })
  const paused = [a, b, c].map((messageId) => ({ messageId, state: 'waiting' }))
  expect(await rig.drafts()).toEqual(paused)
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })

  const d = rig.send('D')
  await d.result
  await handedOver(d.id)
  expect(await rig.drafts()).toEqual(paused)
  await rig.settleAccepted(d.id, 'd')

  // A drains under a fresh ID, preserving the first withdrawn submission.
  const before = new Set([working, firstA, d.id])
  let resentA = ''
  await eventually(async () => {
    const fresh = (await submissionIds()).filter((id) => !before.has(id))
    expect(fresh).toHaveLength(1)
    resentA = fresh[0] ?? ''
  })
  expect((await rig.submission(firstA))?.dispatchState).toBe('rejected')
  expect((await rig.submission(resentA))?.queuedMessageId).toBe(a)
  expect((await rig.submission(firstA))?.queuedMessageId).toBe(a)
  expect(await rig.submission(d.id)).not.toHaveProperty('queuedMessageId')
  expect((await rig.submission(resentA))?.payloadFingerprint).toBe(
    (await rig.submission(firstA))?.payloadFingerprint
  )
  expect(await rig.drafts()).toEqual([
    { messageId: b, state: 'waiting' },
    { messageId: c, state: 'waiting' }
  ])

  await handedOver(resentA)
  await rig.settleAccepted(resentA, 'a')
  await eventually(async () => expect((await rig.handoff(b))?.queuedMessageId).toBe(b))
  expect(await rig.handoff(c)).toBeUndefined()
  await handedOver(await rig.handoffId(b))
  await rig.settleAccepted(await rig.handoffId(b), 'b')
  await eventually(async () => expect(await rig.handoff(c)).toBeDefined())
  expect(await rig.drafts()).toEqual([])
})

it('a Stop whose acceptance fails takes back no hand-off; the draft sends as it was', async () => {
  const working = await rig.workingSend()
  const a = await queuedDraft('A')
  const { release } = holdDelivery()
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect(await rig.handoff(a)).toBeDefined())
  const firstA = await rig.handoffId(a)
  const failing = vi
    .spyOn(JournalStopAcceptor.prototype, 'accept')
    .mockRejectedValueOnce(new Error('disk full'))
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const stopped = rig.stop()
    release()
    expect(await stopped).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'stopFailed' } }
    })
  } finally {
    failing.mockRestore()
    warned.mockRestore()
    release()
  }
  await eventually(async () => expect((await rig.handoff(a))?.handedOverAt).toBeDefined())
  expect(await rig.handoffId(a)).toBe(firstA)
  expect((await rig.submission(firstA))?.dispatchState).not.toBe('rejected')
})
