import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import type { AgentSessionQueuedMessageMoveAnchor } from '../../../shared/agent-session-wire'
import { QueuedMessageActionParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { QueuedMessageMoveParams } from '../../../shared/rpc-contract/structured-agent-session-queued-edit-params'

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
describe('authoritative queue ordering', () => {
  it('persists mixed-sender ID moves and replays a spent move without reordering again', async () => {
    await rig.workingSend()
    const a = await queue('a')
    const mail = await queue('mail', true)
    const b = await queue('b')
    const c = await queue('c')
    const facts = journal().queuedMessages.list()
    const op = hostTestOperationId()
    expect(await move(c, { beforeMessageId: a }, op)).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(order()).toEqual([c, a, mail, b])
    for (const card of facts) {
      expect(journal().queuedMessages.get(card.messageId)).toEqual({
        ...card,
        position: journal().queuedMessages.get(card.messageId)!.position
      })
    }
    expect(await move(c, { afterMessageId: b })).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(await move(c, { beforeMessageId: a }, op)).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(order()).toEqual([a, mail, b, c])
    expect(await move(mail, { beforeMessageId: a })).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(await move(a, { afterMessageId: mail })).toMatchObject({
      ok: true,
      value: { status: 'unchanged' }
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
    expect(order()).toEqual([mail, a, c, b])
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    await rig.restartHostProcess()
    const reopened = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    expect(reopened).toMatchObject({
      ok: true,
      page: {
        queuedMessages: [{ messageId: mail }, { messageId: a }, { messageId: c }, { messageId: b }]
      }
    })
    expect(await move(c, { beforeMessageId: a }, op)).toMatchObject({
      ok: true,
      value: { status: 'moved' }
    })
    expect(order()).toEqual([mail, a, c, b])
    expect(journal().queuedMessages.get(mail)?.body).toEqual(facts[1]!.body)
    expect(journal().queuedMessages.list()).toHaveLength(4)
    expect(await rig.deleteQueued(c)).toMatchObject({ ok: true })
    expect(await move(c, { beforeMessageId: null })).toMatchObject({
      ok: true,
      value: { status: 'gone' }
    })
  })

  it('drains moved mail from its new position once, preserving sender and per-card delivery holds', async () => {
    const working = await rig.workingSend()
    const a = await queue('a')
    const mail = await queue('mail', true)
    const held = await queue('held mail', true)
    const b = await queue('b')
    await journal().queuedMessages.hold({ messageIds: [held], reason: 'send_failed' })
    const facts = journal().queuedMessages.list()
    await move(held, { beforeMessageId: a })
    const op = hostTestOperationId()
    await move(mail, { beforeMessageId: a }, op)
    expect(order()).toEqual([held, mail, a, b])
    for (const card of facts) {
      expect(journal().queuedMessages.get(card.messageId)).toEqual({
        ...card,
        position: journal().queuedMessages.get(card.messageId)!.position
      })
    }
    await rig.settleAccepted(working, 'work')
    await eventually(async () => expect(await rig.handoff(mail)).toBeDefined())
    expect(await rig.handoff(a)).toBeUndefined()
    expect(await rig.handoff(held)).toBeUndefined()
    const submission = await rig.handoffId(mail)
    await eventually(() => {
      const sent = rig.dispatch.mock.calls.find(([input]) => input.clientMessageId === submission)
      expect(sent?.[0].body).toEqual(facts.find((card) => card.messageId === mail)!.body)
    })
    expect(await move(mail, { beforeMessageId: a }, op)).toMatchObject({
      ok: true,
      replayed: true,
      value: { status: 'moved' }
    })
    for (const [id, turn] of [
      [mail, 'mail'],
      [a, 'a'],
      [b, 'b']
    ] as const) {
      await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
      await rig.settleAccepted(await rig.handoffId(id), turn)
    }
    const snapshot = await rig.host.journalSnapshot(HOST_TEST_SESSION)
    expect(snapshot.submissions.flatMap((entry) => entry.queuedMessageId ?? [])).toEqual([
      mail,
      a,
      b
    ])
    expect(order()).toEqual([held])
    expect(journal().queuedMessages.get(held)).toEqual({
      ...facts.find((card) => card.messageId === held)!,
      position: facts[0]!.position
    })
  })

  it('keeps the strict old Send shape and accepts exactly one move anchor', () => {
    const envelope = rig.envelope({}, 'agentSession.queuedMessageDelete', hostTestOperationId())
    const old = { envelope, messageId: 'one' }
    expect(QueuedMessageActionParams.parse(old)).toEqual(old)
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

it('reorders and edits durable image cards without changing attachments or captured options', async () => {
  const working = await rig.workingSend()
  const first = await queue('first')
  const body = hostTestMessage('with image')
  body.blocks.push({ type: 'image-ref', path: '/tmp/queued.png' })
  const choices = { model: 'model-a', effort: 'high', fastMode: 'true', serviceTier: 'priority' }
  const fields = { body, delivery: 'queue-if-active' as const, options: choices }
  const sent = await rig.host.send(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()),
    ...fields
  })
  if (!sent.ok || !('queued' in sent.value)) {
    throw new Error('expected queued image')
  }
  const image = sent.value.queued.messageId
  const last = await queue('last')
  expect(await move(image, { beforeMessageId: first })).toMatchObject({
    ok: true,
    value: { messageId: image, status: 'moved' }
  })
  expect((await rig.drafts()).map((card) => card.messageId)).toEqual([image, first, last])
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  const card = journal?.queuedMessages.get(image)
  if (!card) {
    throw new Error('expected image card')
  }
  const edit = {
    messageId: image,
    expectedBodyFingerprint: card.fingerprint,
    text: 'edited image caption'
  }
  expect(
    await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(edit, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
      ...edit
    })
  ).toMatchObject({ ok: true, value: { status: 'updated' } })
  await rig.restartHostProcess()
  const history = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!history.ok) {
    throw new Error('history refused')
  }
  expect(history.page.queuedMessages?.map((entry) => entry.messageId)).toEqual([image, first, last])
  expect(history.page.queuedMessages?.[0]?.body.blocks).toEqual([
    { type: 'text', text: 'edited image caption' },
    { type: 'image-ref', path: '/tmp/queued.png' }
  ])
  await rig.deleteQueued(first)
  expect((await rig.drafts()).map((entry) => entry.messageId)).toEqual([image, last])
  await rig.settleAccepted(working, 'finished')
  expect(await rig.sendNow(image)).toMatchObject({ ok: true })
  await eventually(async () => expect((await rig.handoff(image))?.options).toMatchObject(choices))
})
