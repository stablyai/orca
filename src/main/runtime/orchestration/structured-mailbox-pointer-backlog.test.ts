import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost,
  type StructuredPointerSendOutcome
} from './structured-mailbox-pointer-delivery'
import type { StructuredMailSubmission } from './structured-pointer-operation-id'
import { HOST_TEST_SESSION } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'

const MAILBOX = 'term_chat'
const WAIT = { timeout: 10_000 }

function lane(db: OrchestrationDb, host: StructuredMailboxPointerHost) {
  return new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: HOST_TEST_SESSION, dispatchId: null }),
    getCliCommand: () => 'orca',
    senderName: () => null,
    host
  })
}

it('rechecks ownership and consumed rows before each handoff', async () => {
  for (const mode of ['batch', 'page', 'consumed'] as const) {
    const db = new OrchestrationDb(':memory:')
    let outstanding = false
    vi.spyOn(db, 'hasOutstandingMailboxDelivery').mockImplementation(() => outstanding)
    const messages = Array.from({ length: 51 }, () =>
      db.insertMessage({ from: 'worker', to: MAILBOX, subject: 'report' })
    )
    let sends = 0
    const delivery = lane(db, {
      readSessionFacts: async () => ({ submissions: [] }),
      currentFence: () => 1,
      currentContextClearOperationId: () => undefined,
      hasActionablePromptNow: () => false,
      send: async () => {
        sends++
        if (sends === (mode === 'page' ? 50 : 1)) {
          await Promise.resolve()
          if (mode === 'consumed') {
            db.markAsRead(messages.slice(1, 50).map((m) => m.id))
          } else {
            outstanding = true
          }
        }
        return { kind: 'sent', state: 'accepted' }
      }
    })
    try {
      delivery.deliverForHandle(MAILBOX)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(sends).toBe(mode === 'page' ? 50 : mode === 'consumed' ? 2 : 1)
      if (mode === 'batch' || mode === 'page') {
        outstanding = false
        delivery.deliverForHandle(MAILBOX)
        await vi.waitFor(() => expect(sends).toBe(51), WAIT)
      }
    } finally {
      db.close()
    }
  }
})

it('visits all reports in order across pending, accepted and failed prefixes without consuming earlier mail', async () => {
  for (const state of ['pending', 'queued', 'accepted', 'unknown', 'rejected'] as const) {
    const db = new OrchestrationDb(':memory:')
    const submissions = new Map<string, StructuredMailSubmission>()
    const providerStarts = new Set<string>()
    const issued: string[] = []
    const settles: ((outcome: StructuredPointerSendOutcome) => void)[] = []
    const report = () => db.insertMessage({ from: 'term_worker', to: MAILBOX, subject: 'report' })
    try {
      const messages = Array.from({ length: 51 }, report)
      const delivery = lane(db, {
        readSessionFacts: async () => ({ submissions: [...submissions.values()] }),
        currentFence: () => 1,
        currentContextClearOperationId: () => undefined,
        hasActionablePromptNow: () => false,
        send: (input) => {
          const source = input.body.from?.orchestration
          const messageId =
            source?.message === 'mail-notice' ? source.messages[0]?.messageId : undefined
          if (!messageId) {
            throw new Error('mail identity missing')
          }
          issued.push(messageId)
          providerStarts.add(input.operationId)
          submissions.set(input.operationId, {
            clientMessageId: input.operationId,
            mailMessageId: messageId,
            dispatchState: state === 'queued' ? 'accepted' : state,
            submittedAt: Date.now()
          })
          input.onAnswered?.()
          return state === 'pending'
            ? new Promise((resolve) => settles.push(resolve))
            : Promise.resolve(state === 'queued' ? { kind: 'queued' } : { kind: 'sent', state })
        }
      })
      delivery.deliverForHandle(MAILBOX)
      await vi.waitFor(() => expect(issued).toEqual(messages.map((message) => message.id)), WAIT)
      expect(providerStarts.size).toBe(51)
      if (state === 'pending') {
        expect(db.getUnreadMessages(MAILBOX)).toHaveLength(51)
        settles.forEach((settle) => settle({ kind: 'sent', state: 'unknown' }))
        // Once the wait expires, durable pending submissions still cannot hide newer mail.
        const next = report()
        delivery.deliverForHandle(MAILBOX)
        await vi.waitFor(() => expect(issued.at(-1)).toBe(next.id), WAIT)
        expect(issued).toHaveLength(52)
        settles.at(-1)?.({ kind: 'sent', state: 'unknown' })
      } else if (state === 'unknown' || state === 'rejected') {
        expect(db.getUnreadMessages(MAILBOX)).toHaveLength(51)
        delivery.onJournalActivity(HOST_TEST_SESSION)
        await vi.waitFor(() => expect(issued).toHaveLength(102), WAIT)
        expect(issued.slice(51)).toEqual(messages.map((message) => message.id))
        expect(providerStarts.size).toBe(51)
        await new Promise((resolve) => setImmediate(resolve))
        expect(issued).toHaveLength(102)
      } else {
        await vi.waitFor(() => expect(db.getUnreadMessages(MAILBOX)).toEqual([]), WAIT)
      }
    } finally {
      await new Promise((resolve) => setImmediate(resolve))
      db.close()
    }
  }
})
