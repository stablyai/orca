import './rpc/unused-default-rpc-methods.test-fixture'
// `worker-start --terminal orca_session_id:<id>`: a chat adopted as a worker, on the
// coordinator-mail rig. Its task is a queued send, read the way the terminal path reads its own
// write; a stop or a failed start never touches the chat.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import type { FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
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
  request,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

beforeEach(() => {
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(async (selector) => ({
    id: selector.replace(/^id:/, ''),
    repoId: 'repo'
  }))
})

/** A person's turn in the worker chat, started and still running; resolves to its end. */
async function runningUserTurn(chat: FakeConnection): Promise<() => Promise<void>> {
  expect(await sendUserMessage(PEER_CHAT, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'user-turn' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: 'echo-go',
      clientId: chat.turns[0]!.clientUserMessageId,
      content: [{ type: 'text', text: 'go' }]
    }
  })
  await host.flushStreamedEvents(PEER_CHAT)
  return async () => {
    notify('turn/completed', { turn: { id: 'user-turn' } })
    await host.flushStreamedEvents(PEER_CHAT)
  }
}

function startWorker(params: Record<string, unknown> = {}) {
  return call(
    'orchestration.workerStart',
    { task: params.task, terminal: WORKER, ...params },
    { sessionId: COORDINATOR }
  )
}

async function refusal(params: Record<string, unknown>) {
  const response = await dispatcher.dispatch(
    request('orchestration.workerStart', params, { sessionId: COORDINATOR })
  )
  if (response.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(response)}`)
  }
  return response.error
}

function expectChatOpen(): void {
  expect(host.hasSession(PEER_CHAT)).toBe(true)
  expect(host.deps.store.getVisibleSessionTabIndex().sessionIds).toContain(PEER_CHAT)
}

describe('worker-start --terminal names a chat', () => {
  it('is ready once an idle chat takes its task, and records the chat as an external worker', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()

    const started = startWorker({ task: taskId })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(PEER_CHAT, 0)
    const receipt = await started

    expect(receipt).toMatchObject({
      state: 'ready',
      turnStart: 'observed',
      mode: {
        detail: `--terminal names the chat ${WORKER}; its task goes to that chat and no agent is launched.`
      }
    })
    const dispatchId = String(receipt.dispatchId)
    const task = turnText(worker.turns[0]!)
    expect(task).toContain(`Your Orca session ID is: ${WORKER}`)
    expect(task).toContain('The coordinator cannot see this chat')
    expect(task).toContain('it will send this chat a fresh')
    expect(task).not.toContain('this terminal')
    expect(task).not.toMatch(/exit the shell/i)
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: WORKER,
      assignee_orca_session_id: PEER_CHAT,
      assignee_pane_key: null,
      process_incarnation: null
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      terminal_handle: WORKER,
      ownership_state: 'external'
    })
  })

  it('hands a busy chat its task as a queued card and reads the start as unknown, not failed', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(worker)

    const receipt = await startWorker({ task: taskId })

    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      turnStart: 'unobserved',
      lastError: expect.stringMatching(
        /waiting as a card in the chat's queue and is sent when the queue reaches it\..*worker-abandon .* does not remove the card/
      ),
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', id: WORKER, state: 'accepted' }),
        expect.objectContaining({ kind: 'dispatch_input', id: WORKER, state: 'turn_unobserved' })
      ])
    })
    expect(JSON.stringify(receipt.nextCommands)).not.toContain('terminal read')
    expect(JSON.stringify(receipt.nextCommands)).toContain('worker-abandon')
    const dispatchId = String(receipt.dispatchId)
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('start_unknown')
    expect(worker.turns).toHaveLength(1)

    await endTurn()
    await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
    expect(turnText(worker.turns[1]!)).toContain(dispatchId)
  })

  it("reads the start as unknown when the chat's agent has not taken the task within the wait", async () => {
    await openChat(COORDINATOR)
    await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    // The settlement wait running out, as for an agent still starting.
    vi.spyOn(host, 'waitForSendSettlement').mockResolvedValue(undefined)

    const receipt = await startWorker({ task: taskId })

    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      turnStart: 'unobserved',
      lastError: expect.stringContaining("the chat's agent had not started to take it")
    })
    expect(db.getWorkerDispatch(String(receipt.dispatchId))?.state).toBe('start_unknown')
  })

  it('is stopped and abandoned without closing or interrupting the chat', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const started = startWorker({ task: taskId })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(PEER_CHAT, 0)
    const dispatchId = String((await started).dispatchId)

    expect(await call('orchestration.workerList', {})).toMatchObject({
      workers: [{ dispatchId, projection: { liveness: { verdict: 'live' } } }]
    })
    // What the chat reports when the person types into it, a /clear included: a chat is no
    // minted worker, so there is nothing to take over and its Dispatch is untouched.
    expect(await call('orchestration.workerTerminalUserInput', { sessionId: PEER_CHAT })).toEqual({
      changed: 0
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('external')
    expect(await call('orchestration.workerStop', { dispatch: dispatchId })).toMatchObject({
      state: 'stop_unknown',
      processAction: 'none'
    })
    expectChatOpen()
    expect(await call('orchestration.workerAbandon', { dispatch: dispatchId })).toMatchObject({
      state: 'abandoned',
      processAction: 'none'
    })
    expectChatOpen()
  })
})

describe('worker-start --terminal refuses a chat before anything is created', () => {
  async function expectNothingCreated(error: unknown, code: string) {
    expect(error).toMatchObject({ code })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 0 })
  }

  it('when it is the coordinator itself', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const self = formatOrcaSessionAddress(testOrcaSessionId(COORDINATOR))

    await expectNothingCreated(
      await refusal({ task: taskId, terminal: self }),
      'terminal_is_coordinator'
    )
  })

  it('when it works in another worktree', async () => {
    await openChat(COORDINATOR)
    await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()

    await expectNothingCreated(
      await refusal({ task: taskId, terminal: WORKER, worktree: 'id:other-worktree' }),
      'terminal_worktree_mismatch'
    )
  })

  it('when it was closed', async () => {
    await openChat(COORDINATOR)
    await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    await host.setSessionTabVisibility(PEER_CHAT, false)

    await expectNothingCreated(
      await refusal({ task: taskId, terminal: WORKER }),
      'session_caller_not_live'
    )
  })

  it('when it is named on another host, before any remote call', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const remote = vi.spyOn(runtime, 'resolveOrchestrationWorkerServer')

    await expectNothingCreated(
      await refusal({ task: taskId, terminal: WORKER, on: 'box' }),
      'session_caller_host_boundary'
    )
    expect(remote).not.toHaveBeenCalled()
  })
})
