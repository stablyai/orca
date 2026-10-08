import './rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../shared/agent-session-wire'
import { QUEUED_MESSAGE_REPLAY_WINDOW_MS } from '../native-chat/agent-session-journal/journal-queued-messages'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from './orchestration/structured-mailbox-pointer-host'
import { operationId } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  WAIT,
  call,
  clearChat,
  connectionFor,
  coordinatorRunAndTask,
  db,
  host,
  openChat,
  runtime,
  sendUserMessage,
  settleTurn,
  startSuccessor
} from './structured-chat-coordinator-mail-rig.test-fixture'

function journal(sessionId = COORDINATOR) {
  const opened = host.collaboratorsForTests().sessions.get(sessionId)
  if (!opened) {
    throw new Error('the test conversation is not open')
  }
  return opened.journal
}

function noticeMessages(body: AgentJournalMessageItem | undefined) {
  const notice = body?.from?.orchestration
  if (notice?.message !== 'mail-notice') {
    throw new Error('expected an orchestration mail notice')
  }
  return notice.messages
}

function pointerLane(mailbox: string, sessionId: () => string = () => COORDINATOR) {
  const adapter = createStructuredMailboxPointerHost()
  const send = vi.fn<StructuredMailboxPointerHost['send']>((input) => adapter.send(input))
  const readSessionFacts = vi.fn<StructuredMailboxPointerHost['readSessionFacts']>((id) =>
    adapter.readSessionFacts(id)
  )
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (handle) =>
      handle === mailbox ? { sessionId: sessionId(), dispatchId: null } : null,
    getCliCommand: () => 'orca',
    senderName: () => null,
    host: { ...adapter, send, readSessionFacts }
  })
  return { delivery, send, readSessionFacts }
}

function insertMail(runId: string, subject: string) {
  return db.insertMessage({ from: 'term_worker', to: `run:${runId}`, runId, subject })
}

async function busyMailbox() {
  const chat = await openChat(COORDINATOR)
  const { runId } = await coordinatorRunAndTask()
  expect(await sendUserMessage(COORDINATOR, 'working')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
  await host.flushStreamedEvents(COORDINATOR)
  return { chat, runId, mailbox: `run:${runId}` }
}

async function loseQueueStamp(mailbox: string, lane: ReturnType<typeof pointerLane>) {
  const stamp = vi.spyOn(db, 'markAsDelivered').mockImplementationOnce(() => {
    throw new Error('mailbox stamp failed after queue commit')
  })
  lane.delivery.deliverForHandle(mailbox)
  await vi.waitFor(() => expect(stamp).toHaveBeenCalledTimes(1), WAIT)
  expect(journal().queuedMessages.list()).toHaveLength(1)
  const original = journal().queuedMessages.list()[0]!
  expect(db.getStructuredPointerOperation(mailbox)?.operation_id).toBe(original.messageId)
  expect(db.getUndeliveredUnreadMessages(mailbox).length).toBeGreaterThan(0)
  return original
}

beforeEach(() => {
  // These tests drive the delivery actor explicitly; host queue/drain and database remain real.
  vi.spyOn(runtime, 'onStructuredSessionStatusForMail').mockImplementation(() => {})
})

describe('queued orchestration notice recovery', () => {
  it('skips the journal when there is no candidate attention and no stored operation', async () => {
    await openChat(COORDINATOR)
    const { runId } = await coordinatorRunAndTask()
    const lane = pointerLane(`run:${runId}`)
    lane.delivery.deliverForHandle(`run:${runId}`)
    await host.flushStreamedEvents(COORDINATOR)
    expect(lane.readSessionFacts).not.toHaveBeenCalled()
    expect(lane.send).not.toHaveBeenCalled()
  })

  it('does not read the journal again after successful handoff leaves no candidate or operation', async () => {
    await openChat(COORDINATOR)
    const { runId } = await coordinatorRunAndTask()
    const mailbox = `run:${runId}`
    insertMail(runId, 'A')
    const lane = pointerLane(mailbox)
    lane.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(connectionFor(COORDINATOR).turns).toHaveLength(1), WAIT)
    await settleTurn(COORDINATOR, 0)
    await vi.waitFor(() => expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([]), WAIT)
    await host.flushStreamedEvents(COORDINATOR)
    expect(lane.send).toHaveBeenCalledTimes(1)
    expect(lane.readSessionFacts).toHaveBeenCalledTimes(1)
  })

  it('reconciles a stored queue operation even when all its members are already fetched', async () => {
    const { runId, mailbox } = await busyMailbox()
    insertMail(runId, 'A')
    await loseQueueStamp(mailbox, pointerLane(mailbox))
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })
    const recovered = pointerLane(mailbox)
    recovered.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(db.getStructuredPointerOperation(mailbox)).toBeUndefined(), WAIT)
    expect(recovered.readSessionFacts).toHaveBeenCalledTimes(1)
    expect(recovered.send).not.toHaveBeenCalled()
    expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([])
  })

  it('retains the original operation when the host cannot read its queue', async () => {
    const { runId, mailbox } = await busyMailbox()
    const a = insertMail(runId, 'A')
    const original = await loseQueueStamp(mailbox, pointerLane(mailbox))
    const queueRead = vi.spyOn(journal().queuedMessages, 'list').mockImplementationOnce(() => {
      throw new Error('queue facts are unavailable')
    })
    const recovered = pointerLane(mailbox)
    recovered.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(recovered.readSessionFacts).toHaveBeenCalledTimes(1), WAIT)
    await expect(recovered.readSessionFacts.mock.results[0]?.value).resolves.toBeNull()
    expect(queueRead).toHaveBeenCalled()
    expect(recovered.send).not.toHaveBeenCalled()
    expect(db.getStructuredPointerOperation(mailbox)?.operation_id).toBe(original.messageId)
    expect(db.getMessageById(a.id)?.delivered_at).toBeNull()
  })

  it('keeps original queue ownership without gating independent mail on repeated stamp failure', async () => {
    const { runId, mailbox } = await busyMailbox()
    const a = insertMail(runId, 'A')
    const original = await loseQueueStamp(mailbox, pointerLane(mailbox))
    vi.spyOn(db, 'markUnpointedMailboxMessagesAsDelivered').mockImplementation(() => {
      throw new Error('queue acceptance stamp still unavailable')
    })
    const c = insertMail(runId, 'C')
    const recovered = pointerLane(mailbox)
    recovered.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(recovered.send).toHaveBeenCalledTimes(1), WAIT)
    expect(noticeMessages(recovered.send.mock.calls[0]?.[0].body)).toMatchObject([
      { messageId: c.id }
    ])
    expect(
      journal()
        .queuedMessages.list()
        .map((card) => card.messageId)
    ).toEqual([original.messageId, recovered.send.mock.calls[0]?.[0].operationId])
    expect(db.getMessageById(a.id)?.delivered_at).toBeNull()
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 2,
      messages: [{ id: a.id }, { id: c.id }]
    })
  })

  it('selects fresh mail after the preflight candidate is fetched during the journal await', async () => {
    const { runId, mailbox } = await busyMailbox()
    const a = insertMail(runId, 'A')
    const lane = pointerLane(mailbox)
    const adapter = createStructuredMailboxPointerHost()
    let release: (() => void) | undefined
    lane.readSessionFacts.mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return adapter.readSessionFacts(id)
    })
    lane.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(release).toBeDefined(), WAIT)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1,
      messages: [{ id: a.id }]
    })
    const b = insertMail(runId, 'B')
    release?.()
    await vi.waitFor(() => expect(lane.send).toHaveBeenCalledTimes(1), WAIT)
    expect(noticeMessages(lane.send.mock.calls[0]?.[0].body)).toMatchObject([{ messageId: b.id }])
  })

  it.each(['unchanged', 'partially fetched'] as const)(
    'a new actor reconciles an accepted %s batch without another card or provider turn',
    async (selection) => {
      const { chat, runId, mailbox } = await busyMailbox()
      if (selection === 'partially fetched') {
        const prefix = Array.from({ length: 49 }, (_, index) =>
          insertMail(runId, `prefix ${index}`)
        )
        db.markAsDelivered(prefix.map((mail) => mail.id))
      }
      const a = insertMail(runId, 'A')
      const b = insertMail(runId, 'B')
      const original = await loseQueueStamp(mailbox, pointerLane(mailbox))
      expect(noticeMessages(original.body).map((mail) => mail.messageId)).toEqual([a.id, b.id])
      if (selection === 'partially fetched') {
        const fetched = await call('orchestration.check', {}, { sessionId: COORDINATOR })
        expect(fetched).toMatchObject({ count: 50 })
        expect(
          db.getUndeliveredUnreadMessages(mailbox, undefined, { excludeFetched: true })
        ).toEqual([expect.objectContaining({ id: b.id })])
      }
      const recovered = pointerLane(mailbox)
      recovered.delivery.deliverForHandle(mailbox)
      await vi.waitFor(() => expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([]), WAIT)
      expect(recovered.send).not.toHaveBeenCalled()
      expect(
        journal()
          .queuedMessages.list()
          .map((card) => card.messageId)
      ).toEqual([original.messageId])
      expect(db.getStructuredPointerOperation(mailbox)).toBeUndefined()

      const c = insertMail(runId, 'C')
      recovered.delivery.deliverForHandle(mailbox)
      await vi.waitFor(() => expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([]), WAIT)
      expect(recovered.send).toHaveBeenCalledTimes(1)
      const cards = journal().queuedMessages.list()
      expect(cards).toHaveLength(2)
      expect(noticeMessages(cards[1]?.body).map((mail) => mail.messageId)).toEqual([c.id])
      await settleTurn(COORDINATOR, 0)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
      await settleTurn(COORDINATOR, 1)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
      await settleTurn(COORDINATOR, 2)
      recovered.delivery.deliverForHandle(mailbox)
      await host.flushStreamedEvents(COORDINATOR)
      expect(chat.turns).toHaveLength(3)
      const notices = (await host.journalSnapshot(COORDINATOR)).submissions.filter(
        (submission) => submission.queuedMessageId
      )
      expect(notices.map((submission) => submission.queuedMessageId)).toEqual(
        cards.map((card) => card.messageId)
      )
      expect(new Set(notices.map((submission) => submission.clientMessageId)).size).toBe(2)
    }
  )

  it('respects withdrawal of an accepted notice and still queues independent mail', async () => {
    const { chat, runId, mailbox } = await busyMailbox()
    insertMail(runId, 'A')
    const original = await loseQueueStamp(mailbox, pointerLane(mailbox))
    await journal().queuedMessages.withdraw({
      messageIds: [original.messageId],
      settledByOp: 'test-withdrawal'
    })
    const recovered = pointerLane(mailbox)
    recovered.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([]), WAIT)
    expect(recovered.send).not.toHaveBeenCalled()
    insertMail(runId, 'C')
    recovered.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(recovered.send).toHaveBeenCalledTimes(1), WAIT)
    await settleTurn(COORDINATOR, 0)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(COORDINATOR, 1)
    expect(
      journal()
        .submissions()
        .some((submission) => submission.queuedMessageId === original.messageId)
    ).toBe(false)
  })

  it('recognizes the original accepted card carried into a successor after clear', async () => {
    const { runId, mailbox } = await busyMailbox()
    insertMail(runId, 'A')
    const original = await loseQueueStamp(mailbox, pointerLane(mailbox))
    await journal().queuedMessages.hold({
      messageIds: [original.messageId],
      reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
    })
    await settleTurn(COORDINATOR, 0)
    const successor = await clearChat(COORDINATOR)
    const carried = journal(successor).queuedMessages.get(original.messageId)
    expect(carried).toMatchObject({ carriedFrom: COORDINATOR, state: 'waiting' })
    const recovered = pointerLane(mailbox, () => successor)
    recovered.delivery.deliverForHandle(mailbox)
    await vi.waitFor(() => expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([]), WAIT)
    expect(recovered.send).not.toHaveBeenCalled()
    expect(journal(successor).queuedMessages.list()).toHaveLength(1)
    expect(db.getStructuredPointerOperation(mailbox)).toBeUndefined()
    await startSuccessor(successor)
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(2), WAIT)
    await settleTurn(successor, 1)
    expect(
      journal(successor)
        .submissions()
        .filter((submission) => submission.queuedMessageId)
    ).toMatchObject([{ queuedMessageId: original.messageId }])
  })

  it.each(['pending', 'accepted'] as const)(
    'reconciles a fresh %s handoff as ownership by the original queue operation',
    async (state) => {
      const { runId, mailbox } = await busyMailbox()
      insertMail(runId, 'A')
      const original = await loseQueueStamp(mailbox, pointerLane(mailbox))
      const handoffId = operationId()
      const conversation = journal()
      const fence = host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence
      await conversation.appendSubmission(
        {
          clientMessageId: handoffId,
          payloadFingerprint: original.fingerprint,
          body: original.body,
          fence,
          handoverRecorded: true,
          origin: 'host'
        },
        {
          messageId: original.messageId,
          expect: 'waiting',
          settledByOp: null,
          hostInstance: original.hostInstance
        }
      )
      if (state === 'accepted') {
        await conversation.resolveDispatch({
          clientMessageId: handoffId,
          state,
          fence,
          providerIdentity: null
        })
        const later = Date.now() + QUEUED_MESSAGE_REPLAY_WINDOW_MS + 1
        const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
        try {
          await conversation.queuedMessages.repairAndPrune()
        } finally {
          clock.mockRestore()
        }
        expect(conversation.queuedMessages.list()).toEqual([])
      }
      expect(conversation.submission(handoffId)).toMatchObject({
        queuedMessageId: original.messageId,
        dispatchState: state
      })
      const recovered = pointerLane(mailbox)
      recovered.delivery.deliverForHandle(mailbox)
      await vi.waitFor(
        () => expect(db.getStructuredPointerOperation(mailbox)).toBeUndefined(),
        WAIT
      )
      expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([])
      expect(recovered.send).not.toHaveBeenCalled()
      expect(conversation.queuedMessages.list()).toHaveLength(state === 'accepted' ? 0 : 1)
    }
  )
})
