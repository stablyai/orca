import { expect, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { idOf } from '../../../rpc/orchestration/callers/session.test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  host,
  openChat,
  settleTurn
} from './structured-chat-coordinator-mail-rig.test-fixture'
const workerAddress = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

export async function failedWorker(
  code: unknown = 'httpConnectionFailed',
  failure = 'network',
  resetsAt?: number
) {
  await openChat(COORDINATOR)
  const worker = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const assigning = call(
    'orchestration.dispatch',
    { task: taskId, to: workerAddress, inject: true },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
  const input = worker.turns[0]!
  const notify = (method: string, params: unknown) =>
    worker.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'turn-1' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${input.clientUserMessageId}`,
      clientId: input.clientUserMessageId,
      content: [{ type: 'text', text: 'task' }]
    }
  })
  await host.flushStreamedEvents(PEER_CHAT)
  const assigned = await assigning
  const dispatchId = idOf(assigned.dispatch)
  if (resetsAt) {
    notify('account/rateLimits/updated', {
      rateLimits: {
        primary: {
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: Math.floor(resetsAt / 1000)
        }
      }
    })
  }
  const error = { message: 'Connection unavailable', codexErrorInfo: code }
  notify('error', { threadId: worker.threadId, turnId: 'turn-1', willRetry: false, error })
  notify('turn/completed', { turn: { id: 'turn-1', status: 'failed', error } })
  await host.flushStreamedEvents(PEER_CHAT)
  await vi.waitFor(
    async () => expect((await host.heldDelivery(PEER_CHAT))?.reason.failure).toBe(failure),
    WAIT
  )
  return { dispatchId, worker, notify }
}

export async function healthySibling() {
  const id = '9b51d46c-e098-4acf-8ef6-22cc99779900'
  const worker = await openChat(id)
  const task = await call(
    'orchestration.taskCreate',
    { spec: 'healthy sibling' },
    { sessionId: COORDINATOR }
  )
  const assigning = call(
    'orchestration.dispatch',
    { task: idOf(task.task), to: formatOrcaSessionAddress(testOrcaSessionId(id)), inject: true },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
  await settleTurn(id, 0)
  await assigning
}
