// A consumed draft whose submission a Stop withdrew before the agent had it is
// not a failure: it waits again at its own position under the Stop's hold, so
// it never blocks the paused cards behind it. After the user's next turn the
// whole queue drains one per turn in queue order, the withdrawn draft first,
// under a fresh submission id.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

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
  // The turn ends and the drain consumes A; its delivery is held, so A is not handed over.
  const { release } = holdDelivery()
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect(await rig.handoff(a)).toBeDefined())
  // Never under the draft's own id: the submission names A by its link.
  const firstA = await rig.handoffId(a)
  expect(firstA).not.toBe(a)
  expect((await rig.submission(firstA))?.handedOverAt).toBeUndefined()

  // The Stop runs once the held step returns, ahead of A's handover.
  const stopped = rig.stop()
  release()
  expect(await stopped).toMatchObject({ ok: true })
  // A is back in its place, behind the same queue pause as B and C: no returned card blocks them.
  const paused = [a, b, c].map((messageId) => ({ messageId, state: 'waiting' }))
  expect(await rig.drafts()).toEqual(paused)
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })

  const d = rig.send('D')
  await d.result
  await handedOver(d.id)
  expect(await rig.drafts()).toEqual(paused)
  await rig.settleAccepted(d.id, 'd')

  // After D's turn, A drains first, under another fresh id: the first names the withdrawn submission.
  const before = new Set([working, firstA, d.id])
  let resentA = ''
  await eventually(async () => {
    const fresh = (await submissionIds()).filter((id) => !before.has(id))
    expect(fresh).toHaveLength(1)
    resentA = fresh[0] ?? ''
  })
  expect((await rig.submission(firstA))?.dispatchState).toBe('rejected')
  // Both hand-offs of A name it; D, a direct send, names no draft.
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

// Bookkeeping never fails a Stop: a withdrawal that throws is reported and counts as nothing
// withdrawn, so no pause holds the card it did send back, and that card sends again.
it('a Stop whose withdrawal throws after landing still answers; the draft it released sends again under a fresh id', async () => {
  const working = await rig.workingSend()
  const a = await queuedDraft('A')
  const { release } = holdDelivery()
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect(await rig.handoff(a)).toBeDefined())
  const firstA = await rig.handoffId(a)
  const withdraw = AgentSessionJournal.prototype.rejectQueuedSubmissions
  const failing = vi
    .spyOn(AgentSessionJournal.prototype, 'rejectQueuedSubmissions')
    .mockImplementation(async function (this: AgentSessionJournal, ...args) {
      const withdrawn = await withdraw.apply(this, args)
      // Only the Stop's own withdrawal fails, after it landed; the delivery loop's pass through.
      if (args[1].rejection.kind === 'cancelled') {
        throw new Error('disk full')
      }
      return withdrawn
    })
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const stopped = rig.stop()
    release()
    expect(await stopped).toMatchObject({ ok: true })
    expect(warned).toHaveBeenCalledWith(
      "[agent-session] stop-queued-bookkeeping: Stop's withdrawal failed",
      expect.objectContaining({ step: 'withdrawal', error: new Error('disk full') })
    )
  } finally {
    failing.mockRestore()
    warned.mockRestore()
    release()
  }
  expect((await rig.submission(firstA))?.dispatchState).toBe('rejected')
  const before = new Set([working, firstA])
  await eventually(async () => {
    expect((await submissionIds()).filter((id) => !before.has(id))).toHaveLength(1)
    expect(await rig.drafts()).toEqual([])
  })
})

/** A consumed card whose delivery is held, so a Stop withdraws it ahead of its handover; the
 *  settlement hook throws on that withdrawal's row, leaving the card owed a return. */
async function stopWithSkippedSettlement(): Promise<{ a: string; working: string }> {
  const working = await rig.workingSend()
  const a = await queuedDraft('A')
  const { release } = holdDelivery()
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect(await rig.handoff(a)).toBeDefined())
  const settle = JournalQueuedMessages.prototype.onRowInTransaction
  let skipped = false
  const hook = vi
    .spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction')
    .mockImplementation(function (this: JournalQueuedMessages, db, row) {
      if (!skipped && row.kind === 'dispatch' && row.state === 'rejected') {
        skipped = true
        throw new Error('bookkeeping failed')
      }
      return settle.call(this, db, row)
    })
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const stopped = rig.stop()
    release()
    expect(await stopped).toMatchObject({ ok: true })
  } finally {
    hook.mockRestore()
    warned.mockRestore()
    release()
  }
  expect(skipped).toBe(true)
  return { a, working }
}

it("a Stop whose withdrawal's settlement was skipped still pauses the card it sent back", async () => {
  const { a } = await stopWithSkippedSettlement()
  // The drain heals the skipped return; the Stop's row already pauses whatever comes back.
  await eventually(async () => expect(await rig.queuePause()).toEqual({ reason: 'stopped' }))
  await new Promise((resolve) => setTimeout(resolve, 250))
  // Healed back to waiting, but the Stop's pause holds it: it does not send.
  expect(await rig.drafts()).toEqual([{ messageId: a, state: 'waiting' }])
  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () =>
    expect(
      (await rig.host.journalSnapshot(SESSION)).submissions.filter(
        (entry) => entry.queuedMessageId === a
      )
    ).toHaveLength(2)
  )
})
