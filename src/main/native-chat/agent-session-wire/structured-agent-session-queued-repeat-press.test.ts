// Every draft-button press carries its own operation id, so a second press of
// Send-now, Delete or Resume reaches the host as a new operation. The host
// answers it from the draft's state: nothing sends twice and nothing refuses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  hostTestMessage,
  hostTestOperationId,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

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

describe('a queued Send receipt', () => {
  function params(id: string, text: string) {
    const body = hostTestMessage(text)
    const fields = { body, delivery: 'queue-if-active' as const }
    return { ...fields, envelope: rig.envelope(fields, 'agentSession.send', id) }
  }

  it('accepts concurrent copies once and replays through the draft and its handoff', async () => {
    const working = await rig.workingSend()
    const id = hostTestOperationId()
    const send = params(id, 'one queued message')
    const [first, second] = await Promise.all([
      rig.host.send(CALLER, send),
      rig.host.send(CALLER, send)
    ])
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(second).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { state: 'waiting' } }
    })
    expect(await rig.drafts()).toHaveLength(1)
    expect(rig.store.readCommandReceipt({ kind: 'global' }, id)).toMatchObject({
      verdict: 'readable',
      receipt: { result: { kind: 'queued-draft', messageId: id } }
    })
    await rig.settleAccepted(working, 'finished')
    await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    expect(await rig.host.send(CALLER, send)).toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { queuedMessageId: id } }
    })
    const submissions = (await rig.host.journalSnapshot(SESSION)).submissions
    expect(submissions.filter((entry) => entry.queuedMessageId === id)).toHaveLength(1)
  })

  it('replays a withdrawn draft as spent without sending it', async () => {
    await rig.workingSend()
    const id = hostTestOperationId()
    const send = params(id, 'withdraw me')
    await rig.host.send(CALLER, send)
    await rig.deleteQueued(id)
    expect(await rig.host.send(CALLER, send)).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { messageId: id, state: 'withdrawn' } }
    })
    expect(await rig.handoff(id)).toBeUndefined()
    expect(rig.dispatch).toHaveBeenCalledTimes(1)
  })

  it('rolls back a draft whose receipt cannot be saved', async () => {
    await rig.workingSend()
    const id = hostTestOperationId()
    const db = openTestJournalHostDatabase(rig.root).db
    db.exec(`CREATE TRIGGER fail_draft_receipt BEFORE INSERT ON agent_session_command_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
    await expect(rig.host.send(CALLER, params(id, 'must roll back'))).rejects.toThrow(
      'receipt unavailable'
    )
    expect(await rig.drafts()).toHaveLength(0)
    expect(rig.store.readCommandReceipt({ kind: 'global' }, id)).toEqual({ verdict: 'absent' })
    expect(rig.store.listOperationRows().find((row) => row.operationId === id)).toBeUndefined()
    db.exec('DROP TRIGGER fail_draft_receipt')
    expect(await rig.host.send(CALLER, params(id, 'must roll back'))).toMatchObject({
      ok: true,
      replayed: false
    })
  })
})

it('returns a committed queued Send after its publication fails', async () => {
  await rig.workingSend()
  const id = hostTestOperationId()
  const body = hostTestMessage('committed queued draft')
  const fields = { body, delivery: 'queue-if-active' as const }
  const params = { ...fields, envelope: rig.envelope(fields, 'agentSession.send', id) }
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  journal.observeCommits(() => {
    throw new Error('draft publication failed')
  })
  try {
    expect(await rig.host.send(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { messageId: id, position: 1, state: 'waiting' } }
    })
    expect(await rig.host.send(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(await rig.drafts()).toHaveLength(1)
  } finally {
    journal.observeCommits(() => {})
  }
})
