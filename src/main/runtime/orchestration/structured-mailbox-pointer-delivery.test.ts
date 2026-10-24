import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { readMailHandoff } from './mail-handoff'
import type { StructuredMailEvidence } from './mailbox-settlement'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function harness() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'result' })
  const evidence: StructuredMailEvidence = {
    epoch: 'epoch',
    frontier: 'frontier',
    stopInForce: false,
    submission: undefined,
    owner: null,
    personStopped: false,
    diedTurnId: null
  }
  const send = vi.fn<StructuredMailboxPointerHost['send']>(async (input) =>
    input.beforeRun()
      ? { kind: 'sent', state: 'accepted', clientMessageId: 'actual-submission' }
      : { kind: 'superseded' }
  )
  const host: StructuredMailboxPointerHost = {
    readReceipt: () => ({ verdict: 'absent' }),
    readSessionFacts: async () => ({ epoch: evidence.epoch, frontier: evidence.frontier }),
    readHandoffEvidence: async () => evidence,
    readHandoffEvidenceNow: () => evidence,
    hasActionablePromptNow: () => false,
    currentFence: () => 1,
    currentContextClearOperationId: () => undefined,
    send
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: 'session', dispatchId: null }),
    getCliCommand: () => 'orca',
    senderName: () => null,
    host
  })
  return { db, message, evidence, send, delivery, host }
}

it('a consuming read invalidates a reserved notice before final host admission', async () => {
  const { db, message, delivery, send } = harness()
  let admitted = false
  send.mockImplementation(async (input) => {
    db.recordUnknownMailRead([message])
    admitted = input.beforeRun()
    return { kind: 'superseded' }
  })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(admitted).toBe(false)
  expect(readMailHandoff(db.getMessageById(message.id)?.handoff)?.kind).toBe('unknown')
})

it('a late accepted receipt cannot overwrite a newer read or acknowledgement', async () => {
  const { db, message, delivery, send } = harness()
  send.mockImplementation(async (input) => {
    expect(input.beforeRun()).toBe(true)
    db.recordUnknownMailRead([message])
    const firstRead = db.getMessageById(message.id)!.handoff
    db.recordUnknownMailRead([message])
    expect(db.getMessageById(message.id)!.handoff).not.toBe(firstRead)
    db.markAsRead([message.id])
    return { kind: 'sent', state: 'accepted', clientMessageId: 'actual-submission' }
  })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(db.getMessageById(message.id)).toMatchObject({ read: 1 })
  expect(readMailHandoff(db.getMessageById(message.id)?.handoff)?.kind).toBe('unknown')
})

it('records the actual queue handover identity and retains its ordinary ownership', async () => {
  const { db, message, delivery, send } = harness()
  send.mockResolvedValue({ kind: 'queued', clientMessageId: 'queued-draft' })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() =>
    expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toMatchObject({
      phase: 'offered',
      clientMessageId: 'queued-draft'
    })
  )
  delivery.onJournalActivity('session')
  await Promise.resolve()
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(['accepted', 'absent', 'unreadable'] as const)(
  'reconciles a crashed immutable cohort read-only (%s) before delivering an independent survivor',
  async (receipt) => {
    const { db, message, delivery, send, host } = harness()
    const survivor = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'old survivor' })
    send.mockRejectedValueOnce(new Error('crash before receipt metadata'))
    delivery.deliverForHandle('consumer')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const original = readMailHandoff(db.getMessageById(survivor.id)!.handoff)
    if (original?.kind !== 'structured') {
      throw new Error('missing reserved input')
    }
    db.recordUnknownMailRead([message])
    const fresh = db.insertMessage({
      from: 'sender',
      to: 'consumer',
      subject: 'same-count replacement'
    })
    host.readReceipt = (reference) =>
      reference.operationId !== original.operationId
        ? { verdict: 'absent' }
        : receipt === 'accepted'
          ? {
              verdict: 'readable',
              receipt: {
                operationId: original.operationId,
                sessionId: 'session',
                callerKey: 'caller',
                method: 'agentSession.send',
                fingerprint: 'original',
                acceptedAt: 1,
                status: 'accepted',
                result: { kind: 'queued-draft', messageId: 'actual-queue' }
              }
            }
          : receipt === 'absent'
            ? { verdict: 'absent' }
            : {
                verdict: 'unreadable',
                scope: { kind: 'global' },
                operationId: original.operationId
              }
    delivery.deliverForHandle('consumer')
    await vi.waitFor(() =>
      expect(readMailHandoff(db.getMessageById(fresh.id)?.handoff)).toMatchObject({
        phase: 'offered'
      })
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect(readMailHandoff(db.getMessageById(fresh.id)?.handoff)).toMatchObject({
      manifest: { members: [fresh.id] }
    })
    expect(JSON.stringify(send.mock.calls[1]![0].body.blocks)).toContain(
      'You have 1 orchestration message'
    )
    expect(send.mock.calls[1]![0].body.from?.orchestration).toMatchObject({
      messages: [{ messageId: fresh.id }]
    })
    expect(readMailHandoff(db.getMessageById(survivor.id)?.handoff)).toMatchObject({
      phase: receipt === 'accepted' ? 'offered' : 'reserved',
      operationId: original.operationId,
      manifest: original.manifest
    })
    expect(db.getMessageById(survivor.id)?.recovery_used).toBe(0)
    expect(readMailHandoff(db.getMessageById(message.id)?.handoff)?.kind).toBe('unknown')
  }
)

it('does not turn expiry of an uncertain original operation into proof it never ran', async () => {
  const { db, message, delivery, send } = harness()
  send.mockRejectedValueOnce(new Error('crash'))
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const original = db.getMessageById(message.id)!.handoff
  send.mockResolvedValue({ kind: 'sent', state: 'rejected', nonAdmission: 'expired' })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(db.getMessageById(message.id)!.handoff).toBe(original)
  expect(send).toHaveBeenCalledTimes(2)
})
