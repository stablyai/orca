import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb, type MessagePriority, type MessageType } from './db'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'

let db: OrchestrationDb
let delivery: OrchestrationStructuredMailboxPointerDelivery<{ typeFilter: string[] | undefined }>
let send: ReturnType<typeof vi.fn<StructuredMailboxPointerHost['send']>>
let mailbox: string
let runId: string
let sessionId: string
const waiters = new Set<{ typeFilter: string[] | undefined }>()

function receive(
  subject: string,
  type: MessageType = 'status',
  priority: MessagePriority = 'normal'
) {
  const message = db.insertMessage({ from: 'worker', to: mailbox, runId, subject, type, priority })
  delivery.deliverForHandle(mailbox)
  return message
}

beforeEach(() => {
  vi.useFakeTimers()
  db = new OrchestrationDb(':memory:')
  sessionId = 'coordinator-1'
  runId = db.createRun({
    objective: 'batch review results',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
  mailbox = `run:${runId}`
  waiters.clear()
  send = vi.fn(async () => ({ kind: 'sent', state: 'accepted' }))
  delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => waiters,
    resolveStructuredTarget: () => ({ sessionId, dispatchId: null }),
    getCliCommand: () => 'orca',
    senderName: () => null,
    host: {
      readSessionFacts: async () => ({ submissions: [] }),
      hasActionablePromptNow: () => false,
      currentFence: () => 1,
      currentContextClearOperationId: () => undefined,
      send
    }
  })
})

afterEach(() => {
  delivery.clearPendingBatches()
  db.close()
  vi.useRealTimers()
})

describe('coordinator notification batching', () => {
  it('sends one turn for a burst, with a fixed deadline from the first report', async () => {
    const first = receive('working')
    await vi.advanceTimersByTimeAsync(30_000)
    const second = receive('test completed', 'worker_done')
    delivery.onJournalActivity(sessionId)
    await vi.advanceTimersByTimeAsync(29_999)
    const third = receive('last update')
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![0].body.from).toMatchObject({
      orchestration: {
        messages: [first, second, third].map((message) => ({ messageId: message.id }))
      }
    })
    expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([])
    expect(db.getUnreadMessages(mailbox)).toHaveLength(3)
    receive('next burst')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['status', 'high'],
    ['status', 'urgent'],
    ['question', 'normal'],
    ['escalation', 'normal'],
    ['dispatch', 'normal'],
    ['decision_gate', 'normal']
  ] satisfies [MessageType, MessagePriority][])(
    'delivers %s/%s immediately, including buffered reports, without a trailing wake',
    async (type, priority) => {
      receive('buffered')
      await vi.advanceTimersByTimeAsync(5_000)
      receive('needs attention', type, priority)
      await vi.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledOnce()
      expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).toHaveBeenCalledOnce()
    }
  )

  it('does not send an empty wake after an explicit check consumes the mail', async () => {
    const message = receive('already read')
    db.markAsRead([message.id])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
  })

  it('rechecks current waiter ownership when the batch expires', async () => {
    receive('waiter-owned')
    waiters.add({ typeFilter: undefined })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
    expect(db.getUndeliveredUnreadMessages(mailbox)).toHaveLength(1)
    waiters.clear()
    delivery.deliverForHandle(mailbox)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledOnce()
  })

  it('cancels the old session deadline when its coordinator changes', async () => {
    receive('pending on first coordinator')
    await vi.advanceTimersByTimeAsync(30_000)
    delivery.forgetSession(sessionId)
    sessionId = 'coordinator-2'
    delivery.deliverForHandle(mailbox)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![0].sessionId).toBe('coordinator-2')
  })

  it('flushes a full page immediately so urgent mail behind it is not held', async () => {
    for (let index = 0; index < 50; index++) {
      receive(`report ${index}`)
    }
    receive('urgent behind the page', 'escalation', 'urgent')
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('drops pending timers when changing databases', async () => {
    receive('old database mail')
    delivery.clearPendingBatches()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
    expect(db.getUndeliveredUnreadMessages(mailbox)).toHaveLength(1)
  })
})
