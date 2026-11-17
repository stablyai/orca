import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { idOf } from '../../../rpc/orchestration/callers/session.test-fixture'
import { sendChatTask } from '../../../rpc/methods/orchestration/chat-task-delivery'
import {
  providerFaults,
  type FakeConnection
} from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  dispatcher,
  host,
  openChat,
  queuedCardTexts,
  request,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

/** A person's turn in `sessionId`, started and still running; resolves to its end. */
async function runningUserTurn(
  sessionId: string,
  chat: FakeConnection
): Promise<() => Promise<void>> {
  const index = chat.turns.length
  expect(await sendUserMessage(sessionId, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(index + 1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: `user-${index}` } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-user-${index}`,
      clientId: chat.turns[index]!.clientUserMessageId,
      content: [{ type: 'text', text: 'go' }]
    }
  })
  await host.flushStreamedEvents(sessionId)
  return async () => {
    notify('turn/completed', { turn: { id: `user-${index}` } })
    await host.flushStreamedEvents(sessionId)
  }
}

async function refusal(method: string, params: Record<string, unknown>, sessionId?: string) {
  const response = await dispatcher.dispatch(
    request(method, params, sessionId ? { sessionId } : {})
  )
  if (response.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(response)}`)
  }
  return response.error
}

function dispatchCount(): unknown {
  return db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()
}

describe('a chat as the assignee of orchestration dispatch', () => {
  it('queues one card for one Dispatch however often its task is sent', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(PEER_CHAT, worker)
    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER },
      { sessionId: COORDINATOR }
    )
    const dispatch = db.getDispatchContextById(idOf(result.dispatch))!

    const from = { kind: 'agent' as const, senders: [], orchestration: null }
    const send = () => sendChatTask({ db, dispatch, from, preamble: 'the task' })
    expect(await send()).toBe('queued')
    expect(await send()).toBe('queued')

    expect(await queuedCardTexts(PEER_CHAT)).toEqual(['the task'])
    await endTurn()
  })

  it('keeps the Dispatch open when the chat may have taken its task but never acknowledged it', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    providerFaults.dieBeforeEveryEcho = true

    const error = await refusal(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true },
      COORDINATOR
    )

    expect(error).toMatchObject({ code: 'operation_unknown' })
    expect(worker.turns.length).toBeGreaterThan(0)
    expect(db.db.prepare('SELECT status FROM dispatch_contexts').all()).toEqual([
      { status: 'dispatched' }
    ])
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('refuses a chat that was closed, with no row written', async () => {
    await openChat(COORDINATOR)
    await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    await host.setSessionTabVisibility(PEER_CHAT, false)

    const error = await refusal(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true },
      COORDINATOR
    )

    expect(error).toMatchObject({
      code: 'session_caller_not_live',
      message: `Agent session ${PEER_CHAT} has ended: its chat was closed. No effects were applied.`
    })
    expect(dispatchCount()).toEqual({ n: 0 })
  })

  it("hands the chat its coordinator's mail to the Dispatch whole, so its own check has nothing left", async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER },
      { sessionId: COORDINATOR }
    )
    const dispatchId = idOf(result.dispatch)

    await call(
      'orchestration.send',
      { to: `dispatch:${dispatchId}`, subject: 'also check the tests' },
      { sessionId: COORDINATOR }
    )

    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    expect(turnText(worker.turns[0]!)).toMatch(
      /Subject: also check the tests\n\[Reply: orca(-dev)? orchestration reply --id msg_\w+ --body "\.\.\."\]/
    )
    expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
    await settleTurn(PEER_CHAT, 0)
    expect(await call('orchestration.check', {}, { sessionId: PEER_CHAT })).toMatchObject({
      messages: []
    })
  })
})
