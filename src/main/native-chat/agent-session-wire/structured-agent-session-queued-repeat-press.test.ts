// Every draft-button press carries its own operation id, so a second press of
// Send-now, Delete or Resume reaches the host as a new operation. The host
// answers it from the draft's state: nothing sends twice and nothing refuses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

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

describe('a repeated draft press under a fresh operation id', () => {
  it('Send-now pressed twice sends the draft once and answers both presses with its submission', async () => {
    await openRigTurnFor(rig, await rig.workingSend())
    const draftId = await queuedDraft('send me now')
    const [first, second] = await Promise.all([rig.sendNow(draftId), rig.sendNow(draftId)])
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(second).toMatchObject({ ok: true, replayed: false })
    if (!first.ok || !second.ok) {
      throw new Error('expected both presses answered')
    }
    expect(second.value.clientMessageId).toBe(first.value.clientMessageId)
    const handoffs = (await rig.host.journalSnapshot(SESSION)).submissions.filter(
      (entry) => entry.queuedMessageId === draftId
    )
    expect(handoffs).toHaveLength(1)
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  })

  it('Delete pressed twice withdraws the draft once; the second press says it is already gone', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('delete me')
    const [first, second] = await Promise.all([
      rig.deleteQueued(draftId),
      rig.deleteQueued(draftId)
    ])
    expect(first).toMatchObject({ ok: true, value: { deleted: true, messageId: draftId } })
    expect(second).toMatchObject({
      ok: true,
      value: { deleted: false, messageId: draftId, disposition: 'withdrawn' }
    })
    expect(await rig.drafts()).toHaveLength(0)
  })

  it('Resume pressed twice lifts the pause once; the second press lifts nothing and is not refused', async () => {
    await rig.workingSend()
    await queuedDraft('held by stop')
    await rig.stop()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    const [first, second] = await Promise.all([rig.resume(), rig.resume()])
    expect(first).toMatchObject({ ok: true, value: { resumed: true } })
    expect(second).toMatchObject({ ok: true, value: { resumed: false } })
    expect(await rig.queuePause()).toBeNull()
  })
})
