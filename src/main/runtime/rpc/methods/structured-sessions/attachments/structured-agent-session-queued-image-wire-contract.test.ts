import * as historyPages from '../../../../../native-chat/agent-session-wire/publication/history/agent-session-history-page'
import {
  queuedImageTestBody,
  streamState
} from '../protocol/structured-agent-session-wire-record.test-fixture'
import { seedTestJournalQueueCard } from '../../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'

import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { agentSessionAttachmentStoreRoot } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { call, openStream } from '../protocol/structured-agent-session-rpc.test-fixture'

import { STRUCTURED_MOBILE_CLIENT } from '../protocol/structured-agent-session-rpc-client.test-fixture'
import {
  queuedImageHistoryReader,
  projectQueuedImageCardHistory
} from './structured-agent-session-queued-image-capability'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

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

it('publishes the complete original and exact compact retry tuple through installed history RPC', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  const dir = join(
    agentSessionAttachmentStoreRoot(rig.root),
    '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0a'
  )
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'shot.png')
  await writeFile(path, 'fixture image bytes')
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'Full original first paragraph.\n\nFull second paragraph.' },
      { type: 'image-ref', path },
      { type: 'text', text: 'Full trailing prose after the image.' },
      { type: 'image-ref', path }
    ]
  }
  await rig.host.close(SESSION, 'evict')
  rig.failNextStart(new Error('fixture start failed'))
  const id = hostTestOperationId()
  const fields = { body, options: { model: 'default' } }
  const sent = await call(
    'agentSession.send',
    {
      envelope: rig.envelope(fields, 'agentSession.send', id),
      ...fields
    },
    OLD
  )
  expect(sent.ok).toBe(true)
  await eventually(async () => expect(await rig!.drafts()).toHaveLength(1))
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const original = (await journal.reads.submission(id))!
  const receipt = await journal.reads.receiptFor(id)
  const epoch = journal.cursor().epoch
  const reason = "Codex couldn't restart. Send your message to try again."
  const rejection = {
    kind: 'restartFailed',
    refusal: { code: 'agent_session_operation_invalid', details: { ownerVerdict: 'exited' } }
  }
  const expectedSource = {
    itemId: agentJournalSubmissionKey(id),
    revision: 0,
    body,
    sequence: 3,
    observedAt: original.resolvedAt,
    turnScope: { kind: 'thread' }
  }
  const expectedFailure = {
    itemId: agentJournalSubmissionKey(`start-failure:${id}`),
    revision: 1,
    body: { kind: 'status', text: reason, tone: 'error', failure: rejection },
    sequence: 4,
    observedAt: original.resolvedAt,
    recoveredAt: original.resolvedAt,
    recovered: true,
    turnScope: { kind: 'thread' }
  }
  const expectedSubmission = {
    clientMessageId: id,
    fence: 4,
    payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body),
    dispatchState: 'rejected',
    providerItemId: null,
    reason,
    submittedAt: original.submittedAt,
    resolvedAt: null,
    submittedSequence: 1,
    handoverRecorded: true,
    acceptedSequence: 1,
    origin: 'client',
    source: { kind: 'user' },
    options: { model: 'default' },
    rejection,
    answeredInTurn: null,
    recovered: true
  }
  const expectedControl = {
    messageId: id,
    position: -1,
    body: {
      kind: 'message',
      role: 'user',
      command: { name: 'compact' },
      blocks: [
        {
          type: 'text',
          text: `Full original first paragraph.\n\nFull second paragraph.\n${path}\nFull trailing prose after the image.\n${path}`
        }
      ]
    },
    state: 'returned',
    returnedReason: reason,
    returnedRejection: rejection
  }
  const expected = {
    ok: true,
    page: {
      sessionId: SESSION,
      epoch,
      direction: 'tail',
      items: [expectedSource, expectedFailure],
      removedItemIds: [],
      submissions: [expectedSubmission],
      window: {
        oldest: { epoch, sequence: 3 },
        newest: { epoch, sequence: 4 },
        nextCursor: { epoch, sequence: 3 }
      },
      liveCursor: { epoch, sequence: 4 },
      hasOlder: false,
      hasNewer: false,
      latestTurn: null,
      actionablePromptIds: [],
      working: false,
      fence: 4,
      hostNow: 1_800_000_000_000,
      queuedMessages: [expectedControl],
      queuePause: null,
      nextQueuedMessageId: null,
      backgroundTasks: null
    },
    providerSession: { key: 'session_id', id: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60' }
  }
  const raw = await rig.host.history(
    { sessionId: SESSION, direction: 'tail' },
    undefined,
    queuedImageHistoryReader(OLD)
  )
  const history = projectQueuedImageCardHistory(raw, OLD)
  expect(history).toStrictEqual(expected)
  const rpc = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, OLD)
  if (!rpc.ok) {
    throw new Error('history refused')
  }
  expect(rpc.result).toStrictEqual(expected)
  expect(await journal.reads.item(agentJournalSubmissionKey(id))).toStrictEqual(expectedSource)
  expect(await journal.reads.submission(id)).toStrictEqual({
    ...expectedSubmission,
    resolvedAt: original.resolvedAt,
    keptAsQueuedMessageId: id
  })
  expect(await journal.reads.submissionBody(id)).toStrictEqual(body)
  expect(await journal.reads.receiptFor(id)).toStrictEqual(receipt)
  const frames = await openStream('agentSession.subscribe', { sessionId: SESSION }, OLD)
  const {
    queuedMessages,
    queuePause,
    nextQueuedMessageId,
    backgroundTasks,
    hostNow,
    ...snapshotPage
  } = expected.page
  const emptyBatch = {
    cursor: { epoch, sequence: 4 },
    items: [],
    removedItemIds: [],
    submissions: []
  }
  const response = (result: unknown) => ({
    id: 'request-1',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime-1' },
    streaming: true
  })
  const common = { sessionId: SESSION, fence: 4, hostNow }
  await eventually(() =>
    expect(frames).toStrictEqual([
      response({ type: 'snapshot', ...common, page: snapshotPage, activity: null }),
      response({
        type: 'batch',
        ...common,
        batch: emptyBatch,
        queuedMessages,
        queuePause,
        nextQueuedMessageId
      }),
      response({ type: 'batch', ...common, batch: emptyBatch, backgroundTasks }),
      response({
        type: 'batch',
        ...common,
        batch: emptyBatch,
        latestTurn: null,
        actionablePromptIds: [],
        working: false
      })
    ])
  )
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
  const resume = Promise.withResolvers<void>()
  const hydrate = historyPages.readAgentSessionHydrationPage
  const reading = vi
    .spyOn(historyPages, 'readAgentSessionHydrationPage')
    .mockImplementationOnce(async (...args) => {
      const page = await hydrate(...args)
      pageReady.resolve()
      await resume.promise
      return page
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
    resume.resolve()
    await eventually(() =>
      expect(streamState(frames).items).toContainEqual(
        expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
      )
    )
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
    resume.resolve()
    reading.mockRestore()
  }
})
