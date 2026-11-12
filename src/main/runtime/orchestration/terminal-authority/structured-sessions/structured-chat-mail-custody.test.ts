// A queued mail card is the chat's to hand over only while the chat still owes it: its message unread in
// its mailbox, and that mailbox still this chat's. The queue asks at handover; cleanup is visible only.

import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { structuredAgentSessionMessageSendMutation } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import type { AgentSessionJournal } from '../../../../native-chat/agent-session-journal/journal-store'
import type { AgentMessageSource } from '../../../../../shared/agent-session/agent-session-message-source'
import { agentSessionRefusalNotice } from '../../../../../shared/agent-session/failures/agent-session-refusal-notice'
import { agentSessionWriteKindForMethod } from '../../../../../shared/agent-session/failures/agent-session-write-failure'
import { nextStructuredQueuedMessage } from '../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-gate'
import { idOf } from '../../../rpc/orchestration-session-caller-test-fixture'
import { structuredSessionPointerCallerKey } from '../../mailbox/structured-pointer/structured-mailbox-pointer-host'
import { operationId } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  finishWorker,
  host,
  isWholeMail,
  openChat,
  queuedCardTexts,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** A running turn, optionally with its first handover still unanswered. */
async function busyChat(sessionId: string, startReply?: Promise<void>) {
  const chat = await openChat(sessionId)
  if (startReply) {
    const request = chat.request
    chat.request = async (...args) => {
      const response = await request(...args)
      if (args[0] === 'turn/start') {
        await startReply
      }
      return response
    }
  }
  expect(await sendUserMessage(sessionId, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
  await host.flushStreamedEvents(sessionId)
  return chat
}

function journalOf(sessionId: string): AgentSessionJournal {
  return host.collaboratorsForTests().sessions.get(sessionId)!.journal
}

/** Queue a card behind the running turn: the person's own, or another agent's with `from`. */
async function queueCard(text: string, from?: AgentMessageSource): Promise<string> {
  const mutation = structuredAgentSessionMessageSendMutation({
    sessionId: COORDINATOR,
    clientOperationId: operationId(),
    expectedRuntimeFence: host.deps.store.getConversation(COORDINATOR)!.currentFence,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }],
      ...(from && { from })
    },
    delivery: 'queue-if-active'
  })
  const queued = await host.send(
    { callerKey: 'test-surface' },
    { ...mutation, ...(!from && { userSend: true as const }) }
  )
  expect(queued).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
  return mutation.envelope.clientOperationId
}

describe('a queued mail card runs only while its chat still owes it', () => {
  it('drops an abandoned Dispatch’s card at handover without a turn, keeping the mail unread', async () => {
    await openChat(COORDINATOR)
    const worker = await busyChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const { dispatch } = await call(
      'orchestration.dispatch',
      { task: taskId, to: formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT)) },
      { sessionId: COORDINATOR }
    )
    const dispatchId = idOf(dispatch)
    await call(
      'orchestration.send',
      {
        to: `dispatch:${dispatchId}`,
        subject: 'obsolete assignment',
        body: 'Perform the old work'
      },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(async () => expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1), WAIT)
    // Cleanup that cannot run must not matter: the handover itself refuses the card.
    vi.spyOn(runtime, 'withdrawStaleChatMail').mockImplementation(() => {})
    await call('orchestration.workerAbandon', { dispatch: dispatchId }, { sessionId: COORDINATOR })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')

    await settleTurn(PEER_CHAT, 0)
    await vi.waitFor(async () => expect(await queuedCardTexts(PEER_CHAT)).toEqual([]), WAIT)
    expect(worker.turns.map(turnText).join('\n')).not.toContain('Perform the old work')
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toMatchObject([
      { body: 'Perform the old work' }
    ])
  })

  it('never runs a report card that reset removed, and reset never waits on it', async () => {
    const chat = await busyChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)

    expect(
      await call('orchestration.reset', { messages: true }, { sessionId: COORDINATOR })
    ).toMatchObject({ reset: 'messages' })
    await vi.waitFor(async () => expect(await queuedCardTexts()).toEqual([]), WAIT)
    await vi.waitFor(() => expect(db.getStructuredMailSendMailboxes()).toEqual([]), WAIT)
    await settleTurn(COORDINATOR, 0)
    expect(chat.turns).toHaveLength(1)
  })

  it('moves a waiting report to the chat that took over the Run, never handing it to the old one', async () => {
    const old = await busyChat(COORDINATOR)
    const next = await openChat(PEER_CHAT)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(
      async () => expect((await queuedCardTexts()).join('')).toContain('(worker_done)'),
      WAIT
    )

    await call('orchestration.runUse', { id: runId }, { sessionId: PEER_CHAT })
    await vi.waitFor(() => expect(next.turns).toHaveLength(1), WAIT)
    expect(isWholeMail(turnText(next.turns[0]!))).toBe(true)
    expect(turnText(next.turns[0]!)).toContain('(worker_done)')
    await vi.waitFor(async () => expect(await queuedCardTexts()).toEqual([]), WAIT)
    await settleTurn(COORDINATOR, 0)
    await settleTurn(PEER_CHAT, 0)
    expect(old.turns.map(turnText).join('\n')).not.toContain('(worker_done)')
    await vi.waitFor(() => expect(db.getUnreadMessages(`run:${runId}`)).toEqual([]), WAIT)
  })

  it('refuses an explicit Send of a card no longer owed, removing it without a turn', async () => {
    const reply = Promise.withResolvers<void>()
    try {
      const chat = await busyChat(COORDINATOR, reply.promise)
      const { runId, taskId } = await coordinatorRunAndTask()
      await finishWorker(taskId)
      await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
      const [card] = journalOf(COORDINATOR).queuedMessages.list()
      expect(card).toMatchObject({ state: 'waiting', consumedAs: null })
      expect(chat.steers).toEqual([])
      expect(
        await host.queuedMessageEditHold(
          { callerKey: 'test-surface' },
          {
            sessionId: COORDINATOR,
            messageId: card!.messageId,
            editId: operationId(),
            action: 'acquire',
            expectedBodyFingerprint: card!.fingerprint
          }
        )
      ).toMatchObject({ status: 'held' })
      const deleteCard = host.queuedMessageDelete
      vi.spyOn(host, 'queuedMessageDelete').mockImplementation((caller, params) => {
        if (
          caller.callerKey === structuredSessionPointerCallerKey(COORDINATOR) &&
          params.envelope.sessionId === COORDINATOR &&
          params.messageId === card!.messageId
        ) {
          return Promise.reject(new Error('cleanup unavailable'))
        }
        return deleteCard(caller, params)
      })
      // A check takes the report while its card still waits.
      expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
        runId,
        count: 1
      })
      reply.resolve()
      await settleTurn(COORDINATOR, 0)
      expect(journalOf(COORDINATOR).queuedMessages.get(card!.messageId)).toMatchObject({
        state: 'waiting',
        consumedAs: null
      })
      const fields = { messageId: card!.messageId }
      const sent = await host.queuedMessageSend(
        { callerKey: 'test-surface' },
        {
          envelope: {
            sessionId: COORDINATOR,
            clientOperationId: operationId(),
            expectedRuntimeFence: host.deps.store.getConversation(COORDINATOR)!.currentFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.queuedMessageSend',
              sessionId: COORDINATOR,
              fields
            })
          },
          ...fields
        }
      )
      if (sent.ok) {
        throw new Error('a stale Send went through')
      }
      // The person is told why the card went, on desktop and phone alike.
      expect(agentSessionRefusalNotice(sent.refusal, 'send', { agentName: 'Codex' })).toContain(
        'This chat has moved on.'
      )
      expect(await queuedCardTexts()).toEqual([])
      expect(chat.turns).toHaveLength(1)
      expect(chat.steers).toEqual([])
    } finally {
      reply.resolve()
    }
  })

  it("lets the person's cards pass mail it cannot decide on now, then hands the mail over first once it can", async () => {
    const reply = Promise.withResolvers<void>()
    try {
      const chat = await busyChat(COORDINATOR, reply.promise)
      const { taskId } = await coordinatorRunAndTask()
      await finishWorker(taskId)
      await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
      await queueCard('first question of mine')
      await queueCard('second question of mine')
      const unreadable = vi.spyOn(db, 'areUnreadMessages').mockImplementation(() => {
        throw new Error('database unavailable')
      })
      expect(chat.steers).toEqual([])
      reply.resolve()
      await settleTurn(COORDINATOR, 0)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
      // The person's first card went, in their order; the report and their second card still wait.
      expect(turnText(chat.turns[1]!)).toContain('first question of mine')
      const waiting = await queuedCardTexts()
      expect(waiting).toHaveLength(2)
      expect(waiting[0]).toContain('(worker_done)')
      unreadable.mockRestore()
      await settleTurn(COORDINATOR, 1)
      // Readable again: the older report goes before the person's later card.
      await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
      expect(isWholeMail(turnText(chat.turns[2]!))).toBe(true)
      await settleTurn(COORDINATOR, 2)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(4), WAIT)
      expect(turnText(chat.turns[3]!)).toContain('second question of mine')
    } finally {
      reply.resolve()
    }
  })

  it('hands a Task over without opening the mail database', async () => {
    const chat = await busyChat(COORDINATOR)
    await queueCard('Do the assigned task', {
      kind: 'agent',
      senders: [],
      orchestration: { message: 'task', runId: 'run-task', taskId: 'task', dispatchId: 'd-task' }
    })
    const open = vi.spyOn(runtime, 'getExistingOrchestrationDb').mockImplementation(() => {
      throw new Error('database cannot open')
    })
    await settleTurn(COORDINATOR, 0)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toContain('Do the assigned task')
    expect(open).toHaveBeenCalled()
  })

  it('withdraws a report card once its Run moves to a terminal, so the terminal can be pointed at it', async () => {
    await busyChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    db.bindRun({
      runId,
      coordinatorHandle: 'term_taker',
      coordinatorPaneKey: 'tab_taker:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    // What the runtime's own delivery sees once the chat gives the report back.
    const selectable: number[] = []
    const deliver = runtime.deliverPendingMessagesForHandle.bind(runtime)
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation((handle, types) => {
      if (handle === `run:${runId}`) {
        selectable.push(db.getUndeliveredUnreadMessages(handle).length)
      }
      return deliver(handle, types)
    })
    runtime.withdrawStaleChatMail()
    await vi.waitFor(async () => expect(await queuedCardTexts()).toEqual([]), WAIT)
    await vi.waitFor(() => expect(db.getStructuredMailSends(`run:${runId}`)).toEqual([]), WAIT)
    // Unread and undelivered again, and the terminal's lane is woken to point at it.
    expect(db.getUnreadMessages(`run:${runId}`)).toMatchObject([{ read: 0, delivered_at: null }])
    await vi.waitFor(() => expect(selectable).toContain(1), WAIT)
  })

  it('publishes nothing as next while only undecidable mail waits, and hands it over once readable', async () => {
    const chat = await busyChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    const unreadable = vi.spyOn(db, 'areUnreadMessages').mockImplementation(() => {
      throw new Error('database unavailable')
    })
    await settleTurn(COORDINATOR, 0)
    const journal = journalOf(COORDINATOR)
    const work = host.currentWork(COORDINATOR)!
    // Idle with nothing to hand over: not working, so /clear and the person's sends go through.
    await vi.waitFor(() => expect(work.working()).toBe(false), WAIT)
    const record = host.deps.store.getRecord(COORDINATOR)
    expect(nextStructuredQueuedMessage({ journal, record, work })).toBeNull()
    // The person's Send of that card says what happened, never that Orca restarted.
    const card = journal.queuedMessages.list().find((row) => row.state === 'waiting')
    const fields = { messageId: card!.messageId }
    const sent = await host.queuedMessageSend(
      { callerKey: 'test-surface' },
      {
        envelope: {
          sessionId: COORDINATOR,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getConversation(COORDINATOR)!.currentFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.queuedMessageSend',
            sessionId: COORDINATOR,
            fields
          })
        },
        ...fields
      }
    )
    if (sent.ok) {
      throw new Error('an undecidable Send went through')
    }
    // Worded as the card's Send is, desktop and phone alike, with its step even beside a Retry.
    const write = agentSessionWriteKindForMethod('agentSession.queuedMessageSend', fields)
    for (const retryControl of [false, true]) {
      expect(agentSessionRefusalNotice(sent.refusal, write, { retryControl })).toBe(
        "Orca couldn't confirm this message is still meant for this chat. Your message was not sent. Try again."
      )
    }
    expect(chat.turns).toHaveLength(1)
    // Readable again: the lane's next look wakes the queue, with no action from the person.
    unreadable.mockRestore()
    runtime.withdrawStaleChatMail()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(isWholeMail(turnText(chat.turns[1]!))).toBe(true)
  })

  it('sends a report refused for queue room once the queue frees room, and never spins meanwhile', async () => {
    const reply = Promise.withResolvers<void>()
    try {
      const chat = await busyChat(COORDINATOR, reply.promise)
      const { runId, taskId } = await coordinatorRunAndTask()
      // The person's queue holds almost all the room an agent's message may use.
      for (let card = 0; card < 4; card += 1) {
        const mutation = structuredAgentSessionMessageSendMutation({
          sessionId: COORDINATOR,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getConversation(COORDINATOR)!.currentFence,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'x'.repeat(240_000) }]
          },
          delivery: 'queue-if-active'
        })
        expect(
          await host.send({ callerKey: 'test-surface' }, { ...mutation, userSend: true })
        ).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
      }
      const send = vi.spyOn(host, 'send')
      await finishWorker(taskId)
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), WAIT)
      // The refusal releases the reservation made before the send.
      await vi.waitFor(
        () => expect(db.getUnreadMessages(`run:${runId}`)).toMatchObject([{ delivered_at: null }]),
        WAIT
      )
      // Unrelated journal writes do not retry a refusal into a loop.
      await journalOf(COORDINATOR).appendQueueResume(
        host.deps.store.getConversation(COORDINATOR)!.currentFence
      )
      await vi.waitFor(() => expect(send.mock.calls.length).toBeLessThanOrEqual(2), WAIT)

      // Deleting the person's cards frees room: that journal edge alone sends the report.
      for (const card of journalOf(COORDINATOR).queuedMessages.list()) {
        const fields = { messageId: card.messageId }
        expect(
          await host.queuedMessageDelete(
            { callerKey: 'test-surface' },
            {
              envelope: {
                sessionId: COORDINATOR,
                clientOperationId: operationId(),
                expectedRuntimeFence: host.deps.store.getConversation(COORDINATOR)!.currentFence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.queuedMessageDelete',
                  sessionId: COORDINATOR,
                  fields
                })
              },
              ...fields
            }
          )
        ).toMatchObject({ ok: true })
      }
      await vi.waitFor(async () => {
        const cards = await queuedCardTexts()
        expect(cards).toHaveLength(1)
        expect(cards[0]).toContain('(worker_done)')
      }, WAIT)
      expect(chat.steers).toEqual([])
      reply.resolve()
      await settleTurn(COORDINATOR, 0)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
      expect(isWholeMail(turnText(chat.turns[1]!))).toBe(true)
    } finally {
      reply.resolve()
    }
  })
})
