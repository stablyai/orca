import './rpc/unused-default-rpc-methods.test-fixture'
// A chat as the assignee of `orchestration dispatch`, end to end on the coordinator-mail rig: its
// task arrives as any agent's message into a chat does, and it then works the Dispatch as a
// terminal worker would.

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { sendChatTask } from './rpc/methods/orchestration/chat-task-delivery'
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
  runtime,
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

function queuedRows(sessionId: string) {
  return host.collaboratorsForTests().sessions.get(sessionId)?.journal.queuedMessages.list() ?? []
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

/** Who each agent message in the chat's journal says it is from. */
async function taskSenders(sessionId: string): Promise<unknown[]> {
  return (await host.journalSnapshot(sessionId)).items.flatMap((item) =>
    item.body.kind === 'message' && item.body.from ? [item.body.from] : []
  )
}

function dispatchCount(): unknown {
  return db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()
}

describe('a chat as the assignee of orchestration dispatch', () => {
  it('records the chat by its Orca session ID and sends an idle chat its task as a turn', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { runId, taskId } = await coordinatorRunAndTask()

    const dispatched = call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(PEER_CHAT, 0)
    const result = await dispatched

    expect(result).toMatchObject({ injected: true })
    const dispatchId = idOf(result.dispatch)
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      run_id: runId,
      assignee_handle: WORKER,
      assignee_orca_session_id: PEER_CHAT,
      assignee_pane_key: null,
      process_incarnation: null,
      status: 'dispatched'
    })
    const task = turnText(worker.turns[0]!)
    expect(task).toContain('build it')
    expect(task).toContain(`Your Orca session ID is: ${WORKER}`)
    expect(task).toContain('The coordinator cannot see this chat')
    expect(task).toContain('it will send this chat a fresh')
    expect(task).not.toContain('this terminal')
    expect(task).not.toMatch(/exit the shell/i)
    expect(task).not.toMatch(/address/i)
    expect(task).toContain(dispatchId)
    expect(await taskSenders(PEER_CHAT)).toMatchObject([
      { kind: 'agent', orchestration: { message: 'task', taskId, dispatchId } }
    ])
  })

  it("holds the task as a card in a busy chat's queue, naming the Dispatch, and sends it when the turn ends", async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(PEER_CHAT, worker)

    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true },
      { sessionId: COORDINATOR }
    )

    expect(result).toMatchObject({ injected: true })
    const dispatchId = idOf(result.dispatch)
    expect(worker.turns).toHaveLength(1)
    const from = {
      kind: 'agent',
      senders: [
        {
          party: {
            address: formatOrcaSessionAddress(testOrcaSessionId(COORDINATOR)),
            terminalHandle: null,
            orcaSessionId: COORDINATOR
          }
        }
      ],
      orchestration: { message: 'task', runId, taskId, dispatchId }
    }
    // On the card's body: the turn the queue sends carries it, and the provider never sees it.
    expect(queuedRows(PEER_CHAT).map((card) => card.body.from)).toMatchObject([from])

    await endTurn()
    await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
    expect(turnText(worker.turns[1]!)).toContain(dispatchId)
    expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
    expect(await taskSenders(PEER_CHAT)).toMatchObject([from])
  })

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

  it('refuses a chat that injects a Dispatch into itself, naming no --from, with no row written', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()

    const error = await refusal(
      'orchestration.dispatch',
      { task: taskId, to: formatOrcaSessionAddress(testOrcaSessionId(COORDINATOR)), inject: true },
      COORDINATOR
    )

    expect(error).toMatchObject({
      code: 'terminal_is_coordinator',
      message: expect.stringContaining("is this coordinator's own Orca session ID")
    })
    expect(dispatchCount()).toEqual({ n: 0 })
    expect(db.getTask(taskId)?.status).toBe('ready')
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

  it("points the chat at its coordinator's mail to the Dispatch, which its own check reads", async () => {
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
      /^You have 1 orchestration message\. Run `orca(-dev)? orchestration check`\.$/
    )
    expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
    await settleTurn(PEER_CHAT, 0)
    expect(await call('orchestration.check', {}, { sessionId: PEER_CHAT })).toMatchObject({
      messages: [expect.objectContaining({ subject: 'also check the tests' })]
    })
  })

  it("counts a chat worker's own Dispatch as depth 2, under the nesting cap", async () => {
    await openChat(COORDINATOR)
    await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const parent = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER },
      { sessionId: COORDINATOR }
    )
    expect(parent.dispatch).toMatchObject({ depth: 1 })
    await call('orchestration.runCreate', { objective: 'sub' }, { sessionId: PEER_CHAT })
    const subTask = idOf(
      (await call('orchestration.taskCreate', { spec: 'part' }, { sessionId: PEER_CHAT })).task
    )

    const subDispatch = { task: subTask, to: 'term_worker' }

    expect(await refusal('orchestration.dispatch', subDispatch, PEER_CHAT)).toMatchObject({
      code: 'nested_worker_depth_exceeded'
    })
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(2)
    const child = await call('orchestration.dispatch', subDispatch, { sessionId: PEER_CHAT })
    expect(child.dispatch).toMatchObject({ depth: 2, creator_dispatch_id: idOf(parent.dispatch) })
  })
})
