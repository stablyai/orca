import { projectStructuredAgentSessionMessages } from '../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import * as historyPages from '../../../../../native-chat/agent-session-wire/publication/history/agent-session-history-page'
import {
  queuedImageTestBody,
  streamState
} from '../protocol/structured-agent-session-wire-record.test-fixture'
import { seedTestJournalQueueCard } from '../../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

import 'node:fs/promises'
import 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'

import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import '../../../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { call, openStream } from '../protocol/structured-agent-session-rpc.test-fixture'

import { STRUCTURED_MOBILE_CLIENT } from '../protocol/structured-agent-session-rpc-client.test-fixture'
import { queuedImageHistoryReader } from './structured-agent-session-queued-image-capability'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

const OLD = { ...STRUCTURED_MOBILE_CLIENT, clientId: 'old-phone', connectionId: 'old-phone' }
let rig: QueuedMessageTestRig | undefined

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

it('keeps a saved physical hold independent while its own rejected retry blocks the ordered suffix', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, legacyInputs: true })
  setStructuredAgentSessionHost(rig.host)
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Complete immutable original.' }]
  }
  const id = hostTestOperationId()
  const send = { body, options: { model: 'default' } }
  expect(
    await call(
      'agentSession.send',
      { envelope: rig.envelope(send, 'agentSession.send', id), ...send },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(1))
  for (const text of ['First complete waiting input.', 'Second complete waiting input.']) {
    const fields = {
      body: { ...body, blocks: [{ type: 'text', text }] },
      delivery: 'queue-if-active',
      options: { model: 'default' }
    }
    expect(
      await call(
        'agentSession.send',
        { envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()), ...fields },
        OLD
      )
    ).toMatchObject({ result: { ok: true } })
  }
  await rig.stop()
  await rig.host.flushStreamedEvents(SESSION)
  const j = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const saved = `recovery:${id}`
  await seedTestJournalQueueCard(rig.root, j, {
    messageId: saved,
    state: 'waiting',
    holdReason: 'delivery_unconfirmed',
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    body,
    recovers: id,
    position: -1,
    queuedAt: j.cursor(),
    options: { model: 'default' }
  })
  async function published() {
    const rpc = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, OLD)
    if (!rpc.ok) {
      throw new Error('history refused')
    }
    return rpc.result
  }
  const held = await published()
  expect(held).toHaveProperty('page.queuedMessages', [
    { messageId: saved, position: -1, body, state: 'waiting', paused: true },
    ...(await j.queuedMessages.list())
      .filter((row) => row.messageId !== saved)
      .map((row) => ({
        messageId: row.messageId,
        position: row.position,
        body: row.body,
        state: 'waiting'
      }))
  ])
  const immutable = await j.reads.submission(id)
  const receipt = await j.reads.receiptFor(id)
  await rig.quitRestartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  rig.failNextStart(new Error('saved choice own retry failed'))
  const fields = { messageId: saved }
  const params = {
    envelope: rig.envelope(fields, 'agentSession.queuedMessageSend', hostTestOperationId()),
    ...fields
  }
  expect(await call('agentSession.queuedMessageSend', params, OLD)).toMatchObject({
    result: { ok: true }
  })
  await eventually(async () => expect((await rig!.handoff(saved))?.dispatchState).toBe('rejected'))
  const rejected = await published()
  const state = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const physical = (await state.queuedMessages.get(saved))!
  expect(physical.state).toBe('returned')
  expect(physical.recovers).toBe(id)
  expect(physical.consumedAs).not.toBe(id)
  expect(rejected).toHaveProperty('page.nextQueuedMessageId', null)
  expect(rejected).toHaveProperty('page.queuedMessages.0.state', 'returned')
  expect(await call('agentSession.queuedMessageSend', params, OLD)).toMatchObject({
    result: { ok: true, replayed: true }
  })
  expect(
    await call(
      'agentSession.queuedMessagesResume',
      { envelope: rig.envelope({}, 'agentSession.queuedMessagesResume', hostTestOperationId()) },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
  await published()
  await rig.settleAccepted(id, 'original-positive-proof-independent-of-failed-retry')
  expect(await state.queuedMessages.get(saved)).toStrictEqual(physical)
  expect(await state.reads.submissionBody(id)).toStrictEqual(body)
  expect((await state.reads.submission(id))?.payloadFingerprint).toBe(immutable?.payloadFingerprint)
  expect(await state.reads.receiptFor(id)).not.toEqual(receipt)
  await published()
})

it('keeps a queue edit after the old-reader page whose eligibility read it overlapped', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  await rig.host.close(SESSION, 'evict')
  rig.failNextStart(new Error('fixture start failed'))
  const body = await queuedImageTestBody(rig.root)
  const id = hostTestOperationId()
  const fields = { body }
  expect(
    await call(
      'agentSession.send',
      {
        envelope: rig.envelope(fields, 'agentSession.send', id),
        ...fields
      },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await eventually(async () => expect(await rig!.drafts()).toHaveLength(1))
  const j = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const card = (await j.queuedMessages.list()).find((row) => row.state === 'returned')!
  const cursor = j.cursor()
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const list = j.queuedMessages.list.bind(j.queuedMessages)
  let editing: ReturnType<typeof j.queuedMessages.update> | undefined
  const readingQueue = vi
    .spyOn(j.queuedMessages, 'list')
    .mockImplementationOnce(async () => {
      const rows = await list()
      entered.resolve()
      await resume.promise
      return rows
    })
    .mockImplementation(async () => {
      await editing
      return list()
    })
  try {
    const reading = historyPages.readAgentSessionHistory(
      j,
      { sessionId: SESSION, direction: 'tail' },
      {
        reader: queuedImageHistoryReader(OLD)
      }
    )
    await entered.promise
    editing = j.queuedMessages.update({
      messageId: card.messageId,
      expectedBodyFingerprint: card.fingerprint,
      text: 'overlapping edit'
    })
    resume.resolve()
    const result = await reading
    await editing
    expect(result.page.liveCursor).toEqual(cursor)
    expect(result.page.items).toContainEqual(
      expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
    )
    expect(result.page.submissions.find((send) => send.clientMessageId === id)).not.toHaveProperty(
      'keptAsQueuedMessageId'
    )
    const after = await historyPages.readAgentSessionHistory(
      j,
      { sessionId: SESSION, direction: 'tail' },
      { reader: queuedImageHistoryReader(OLD) }
    )
    expect(after.page.liveCursor!.sequence).toBeGreaterThan(cursor.sequence)
    expect(after.page.submissions.find((send) => send.clientMessageId === id)).toMatchObject({
      keptAsQueuedMessageId: card.messageId
    })
  } finally {
    resume.resolve()
    readingQueue.mockRestore()
  }
})

it('catches up a queue insertion between the old-reader initial page and its side controls', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  await rig.workingSend()
  const j = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const pageReady = Promise.withResolvers<void>()
  const hydrate = historyPages.readAgentSessionHydrationFrame
  // The initial frame reads its page and side controls in the chat's lane, so the send waits for
  // the lane and lands after both, before or after the frame is emitted.
  const reading = vi
    .spyOn(historyPages, 'readAgentSessionHydrationFrame')
    .mockImplementationOnce(async (...args) => {
      const frame = await hydrate(...args)
      pageReady.resolve()
      return frame
    })
  try {
    const frames = await openStream('agentSession.subscribe', { sessionId: SESSION }, OLD)
    await pageReady.promise
    const body = await queuedImageTestBody(rig.root, 'queued after initial page')
    const id = hostTestOperationId()
    const fields = { body, delivery: 'queue-if-active' as const }
    expect(
      await call(
        'agentSession.send',
        {
          envelope: rig.envelope(fields, 'agentSession.send', id),
          ...fields
        },
        OLD
      )
    ).toMatchObject({ result: { ok: true, value: { queued: { messageId: id } } } })
    expect(await j.reads.submission(id)).toBeUndefined()
    const work = await rig.host.currentWork(SESSION)
    const queue = await rig.host.collaboratorsForTests().subscribers.readQueuePublication(SESSION)
    expect(work?.working()).toBe(true)
    expect(queue).toMatchObject({ queuedMessages: [{ messageId: id }], nextQueuedMessageId: null })
    await eventually(() =>
      expect(streamState(frames).items).toContainEqual(
        expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
      )
    )
    await eventually(() => expect(streamState(frames).cursor).toEqual(j.cursor()))
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: expect.objectContaining({
            type: 'batch',
            batch: expect.objectContaining({
              items: expect.arrayContaining([
                expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
              ])
            })
          })
        })
      ])
    )
  } finally {
    reading.mockRestore()
  }
})

it('preserves a returned image through a SQL restart and keeps its deletion after another restart', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  await rig.host.close(SESSION, 'evict')
  rig.failNextStart(new Error('image start refused'))
  const body = await queuedImageTestBody(rig.root, 'saved image')
  const id = hostTestOperationId()
  const fields = { body }
  expect(
    await call(
      'agentSession.send',
      {
        envelope: rig.envelope(fields, 'agentSession.send', id),
        ...fields
      },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await eventually(async () => expect(await rig!.drafts()).toHaveLength(1))
  await rig.quitRestartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  const reopened = await call(
    'agentSession.history',
    { sessionId: SESSION, direction: 'tail' },
    OLD
  )
  expect(reopened).toMatchObject({
    result: {
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
        ]),
        queuedMessages: [
          expect.objectContaining({
            body: expect.objectContaining({ command: { name: 'compact' } })
          })
        ]
      }
    }
  })
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  expect(await journal.reads.submissionBody(id)).toEqual(body)
  const [card] = await journal.queuedMessages.list()
  const deletion = { messageId: card.messageId }
  expect(
    await call(
      'agentSession.queuedMessageDelete',
      {
        envelope: rig.envelope(deletion, 'agentSession.queuedMessageDelete', hostTestOperationId()),
        ...deletion
      },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await rig.quitRestartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  const deleted = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, OLD)
  expect(deleted).toMatchObject({ result: { page: { queuedMessages: [] } } })
  const page = (
    await rig.host.history(
      { sessionId: SESSION, direction: 'tail' },
      undefined,
      queuedImageHistoryReader(OLD)
    )
  ).page
  expect(
    projectStructuredAgentSessionMessages(page.items, [], page.submissions).map((item) => item.id)
  ).not.toContain(agentJournalSubmissionKey(id))
})
