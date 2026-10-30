import './rpc/unused-default-rpc-methods.test-fixture'
// A chat working a Dispatch whose turn fails tells the coordinator's Run, once, in the chat's own
// words, and keeps the task.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  connectionFor,
  db,
  host,
  openChat,
  runtime,
  sendUserMessage,
  settleTurn
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const CAPACITY = 'Selected model is at capacity.'

/** Dispatch the coordinator's task to the worker chat, whose first turn then fails as Codex fails. */
async function dispatchAndFailWorkerTurn(): Promise<{ runId: string; dispatchId: string }> {
  await openChat(COORDINATOR)
  const worker = await openChat(PEER_CHAT)
  const { runId, taskId } = await coordinatorRunAndTask()
  const dispatched = call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER, inject: true },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
  const turn = worker.turns[0]!
  const notify = (method: string, params: unknown) =>
    worker.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'turn-1' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${turn.clientUserMessageId}`,
      clientId: turn.clientUserMessageId,
      content: [{ type: 'text', text: 'task' }]
    }
  })
  notify('error', {
    threadId: worker.threadId,
    turnId: 'turn-1',
    willRetry: false,
    error: { message: CAPACITY }
  })
  notify('turn/completed', { turn: { id: 'turn-1', status: 'failed' } })
  await host.flushStreamedEvents(PEER_CHAT)
  return { runId, dispatchId: idOf((await dispatched).dispatch) }
}

function escalationsTo(runId: string) {
  return db.db
    .prepare(`SELECT * FROM messages WHERE to_handle = ? AND type = 'escalation'`)
    .all(`run:${runId}`)
    .map((row) => {
      if (typeof row.body !== 'string' || typeof row.payload !== 'string') {
        throw new Error('invalid mail row')
      }
      return { body: row.body, payload: row.payload }
    })
}

describe('a chat worker whose turn fails', () => {
  it('tells the Run that dispatched it, once, with the error the chat shows, and keeps the task', async () => {
    vi.spyOn(runtime, 'isChatWorkerErrorEscalationEnabled').mockReturnValue(true)
    const { runId, dispatchId } = await dispatchAndFailWorkerTurn()

    await vi.waitFor(() => expect(escalationsTo(runId)).toHaveLength(1), WAIT)
    const [escalation] = escalationsTo(runId)
    expect(escalation!.body).toContain(`Error: ${CAPACITY}`)
    expect(JSON.parse(escalation!.payload)).toMatchObject({ dispatchId, error: CAPACITY })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({ status: 'dispatched' })

    // Naming republishes presentation state; it cannot turn an old failure into news.
    host.publishConversationName(PEER_CHAT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(escalationsTo(runId)).toHaveLength(1)
  })

  it('keeps the existing failed Dispatch/RPC result for a never-delivered initial preamble, without error mail', async () => {
    vi.spyOn(runtime, 'isChatWorkerErrorEscalationEnabled').mockReturnValue(true)
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { runId, taskId } = await coordinatorRunAndTask()
    const result = call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true },
      { sessionId: COORDINATOR }
    )
    const rejected = expect(result).rejects.toThrow('dispatch_preamble_undelivered')
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    const journal = host.collaboratorsForTests().sessions.get(PEER_CHAT)?.journal
    if (!journal) {
      throw new Error('worker journal missing')
    }
    const submission = journal.pendingSubmissions()[0]
    if (!submission) {
      throw new Error('initial preamble missing')
    }
    await journal.resolveDispatch({
      clientMessageId: submission.clientMessageId,
      fence: submission.fence,
      state: 'rejected',
      ...agentSessionFailureWords(
        { kind: 'providerRejected' },
        { surface: 'rejection', agentName: 'Codex' }
      )
    })
    await rejected
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(db.db.prepare('SELECT status FROM dispatch_contexts').all()).toEqual([
      { status: 'failed' }
    ])
    expect(escalationsTo(runId)).toHaveLength(0)
  })

  it.each(['notify', 'insert'] as const)(
    'accepts the next user turn after coordinator %s fails',
    async (mode) => {
      vi.spyOn(runtime, 'isChatWorkerErrorEscalationEnabled').mockReturnValue(true)
      const failed =
        mode === 'notify'
          ? vi.spyOn(runtime, 'notifyMessageArrived')
          : vi.spyOn(db, 'insertMessage')
      failed.mockImplementation(() => {
        throw new Error('mail unavailable')
      })
      const { runId } = await dispatchAndFailWorkerTurn()
      await vi.waitFor(() => expect(failed).toHaveBeenCalled(), WAIT)
      expect(escalationsTo(runId)).toHaveLength(mode === 'notify' ? 1 : 0)
      const previous = connectionFor(PEER_CHAT)
      const previousCount = previous.turns.length
      expect(await sendUserMessage(PEER_CHAT, 'try again')).toMatchObject({ ok: true })
      await vi.waitFor(() => {
        const current = connectionFor(PEER_CHAT)
        expect(current.turns.length).toBeGreaterThan(current === previous ? previousCount : 0)
      }, WAIT)
      await settleTurn(PEER_CHAT, connectionFor(PEER_CHAT).turns.length - 1)
    }
  )

  it('sends nothing while the Orchestration switch is off', async () => {
    vi.spyOn(runtime, 'isChatWorkerErrorEscalationEnabled').mockReturnValue(false)
    const { runId } = await dispatchAndFailWorkerTurn()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(escalationsTo(runId)).toHaveLength(0)
  })
})
