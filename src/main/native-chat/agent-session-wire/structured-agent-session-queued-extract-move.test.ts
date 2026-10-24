import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import type { AgentSessionQueuedMessageMoveAnchor } from '../../../shared/agent-session-wire'
import { QueuedMessageActionParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  QueuedMessageDeleteParams,
  QueuedMessageMoveParams
} from '../../../shared/rpc-contract/structured-agent-session-queued-edit-params'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())
function journal() {
  const value = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!value) {
    throw new Error('missing journal')
  }
  return value
}
async function queue(text: string, mail = false) {
  const result = await rig.send(
    text,
    'queue-if-active',
    mail
      ? {
          internal: true,
          from: { kind: 'agent', senders: [], orchestration: null }
        }
      : undefined
  ).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error('not queued')
  }
  return result.value.queued.messageId
}
function order() {
  return journal()
    .queuedMessages.list()
    .filter((card) => card.state === 'waiting' || card.state === 'returned')
    .map((card) => card.messageId)
}
function move(
  messageId: string,
  anchor: AgentSessionQueuedMessageMoveAnchor,
  id = hostTestOperationId()
) {
  const fields = { messageId, ...anchor }
  return rig.host.queuedMessageMove(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.queuedMessageMove', id),
    ...fields
  })
}
function remove(messageId: string, expectedBodyFingerprint: string, id = hostTestOperationId()) {
  const fields = { messageId, expectedBodyFingerprint }
  return rig.host.queuedMessageDelete(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.queuedMessageDelete', id),
    ...fields
  })
}

describe('conditional extraction and authoritative queue ordering', () => {
  it('refuses an old copy after Save, then withdraws the exact new copy without lifting Stop', async () => {
    await rig.workingSend()
    const id = await queue('original')
    const original = journal().queuedMessages.get(id)!.fingerprint
    const fields = { messageId: id, expectedBodyFingerprint: original, text: 'newer $review' }
    expect(
      await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    expect(await remove(id, original)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(order()).toEqual([id])
    await rig.stop()
    const stop = journal().queuedMessages.userStopInForce()
    const current = journal().queuedMessages.get(id)!.fingerprint
    const operationId = hostTestOperationId()
    expect(await remove(id, current, operationId)).toMatchObject({
      ok: true,
      value: { deleted: true }
    })
    expect(order()).toEqual([])
    expect(await remove(id, current, operationId)).toMatchObject({
      ok: true,
      value: { deleted: true }
    })
    expect(journal().queuedMessages.userStopInForce()).toEqual(stop)
    // Unconditional Delete from an older peer keeps its original shape and result.
    expect(await rig.deleteQueued(id)).toMatchObject({
      ok: true,
      value: { deleted: false, disposition: 'withdrawn' }
    })
  })

  it('persists ID moves, protects mail slots and replays a spent move without reordering again', async () => {
    await rig.workingSend()
    const a = await queue('a')
    const mail = await queue('mail', true)
    const b = await queue('b')
    const c = await queue('c')
    const facts = journal().queuedMessages.get(c)!
    const op = hostTestOperationId()
    expect(await move(c, { beforeMessageId: a }, op)).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(order()).toEqual([c, mail, a, b])
    expect(journal().queuedMessages.get(c)).toMatchObject({
      body: facts.body,
      queuedAt: facts.queuedAt,
      holdReason: facts.holdReason
    })
    expect(await move(c, { afterMessageId: b })).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(await move(c, { beforeMessageId: a }, op)).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(order()).toEqual([a, mail, b, c])
    expect(await move(a, { beforeMessageId: mail })).toMatchObject({
      ok: true,
      value: { status: 'stale' }
    })
    expect(await move(mail, { beforeMessageId: a })).toMatchObject({
      ok: true,
      value: { status: 'gone' }
    })
    const missingOp = hostTestOperationId()
    expect(await move(a, { afterMessageId: 'absent' }, missingOp)).toMatchObject({
      ok: true,
      value: { status: 'stale' }
    })
    expect(await move(c, { afterMessageId: a })).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(order()).toEqual([a, mail, c, b])
    await rig.restartHostProcess()
    const reopened = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    expect(reopened).toMatchObject({
      ok: true,
      page: {
        queuedMessages: [{ messageId: a }, { messageId: mail }, { messageId: c }, { messageId: b }]
      }
    })
    expect(await move(c, { beforeMessageId: a }, op)).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(order()).toEqual([a, mail, c, b])
    expect(await rig.deleteQueued(c)).toMatchObject({ ok: true })
    expect(await move(c, { beforeMessageId: null })).toMatchObject({
      ok: true,
      value: { status: 'gone' }
    })
  })

  it('keeps the strict old Send shape and accepts exactly one move anchor', () => {
    const envelope = rig.envelope({}, 'agentSession.queuedMessageDelete', hostTestOperationId())
    const old = { envelope, messageId: 'one' }
    expect(QueuedMessageActionParams.parse(old)).toEqual(old)
    expect(QueuedMessageDeleteParams.parse(old)).toEqual(old)
    expect(
      QueuedMessageActionParams.safeParse({ ...old, expectedBodyFingerprint: 'f'.repeat(64) })
        .success
    ).toBe(false)
    expect(
      QueuedMessageDeleteParams.safeParse({ ...old, expectedBodyFingerprint: 'f'.repeat(64) })
        .success
    ).toBe(true)
    expect(QueuedMessageMoveParams.safeParse({ ...old, beforeMessageId: null }).success).toBe(true)
    expect(QueuedMessageMoveParams.safeParse({ ...old, afterMessageId: 'neighbor' }).success).toBe(
      true
    )
    expect(
      QueuedMessageMoveParams.safeParse({
        ...old,
        beforeMessageId: null,
        afterMessageId: 'neighbor'
      }).success
    ).toBe(false)
    expect(QueuedMessageMoveParams.safeParse(old).success).toBe(false)
  })
})
