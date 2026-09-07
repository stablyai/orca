import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  mintAgentSessionOperationId,
  resolveStructuredPointerOperation
} from './structured-pointer-operation-id'

const OPERATION_ID_PATTERN = /^\d{13}-[0-9a-f]{32}$/

function body(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function fakeDb() {
  const rows = new Map<string, { mailbox_handle: string; operation_id: string }>()
  return {
    rows,
    getStructuredPointerOperation: (handle: string) => rows.get(handle),
    putStructuredPointerOperation: (row: { mailbox_handle: string; operation_id: string }) =>
      rows.set(row.mailbox_handle, row)
  } as never
}

describe('structured pointer operation id', () => {
  it('mints ids the host will admit', () => {
    // Orchestration's own msg_<hex> ids do not match and are refused before the first send.
    expect(mintAgentSessionOperationId(Date.now())).toMatch(OPERATION_ID_PATTERN)
  })

  it('reuses one id for the same batch', () => {
    const db = fakeDb()
    const first = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const second = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 2_000
    })
    expect(second.operationId).toBe(first.operationId)
    expect(second.payloadFingerprint).toBe(first.payloadFingerprint)
  })

  it('re-mints when the batch grows', () => {
    const db = fakeDb()
    const first = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const grown = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('3 messages'),
      messageIds: ['m1', 'm2', 'm3'],
      now: 1_500
    })
    expect(grown.operationId).not.toBe(first.operationId)
  })

  it('re-mints once the host would refuse the id as expired', () => {
    const db = fakeDb()
    const first = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const aged = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000 + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
    })
    expect(aged.operationId).not.toBe(first.operationId)
  })

  it('re-mints for a different batch of the same size', () => {
    // The pointer body names only how many messages are waiting, so two unrelated same-size
    // batches share a payload fingerprint. Reusing the live id across them makes the host replay
    // its ledger answer — `accepted`, with no turn sent — and the lane then marks the NEW mail
    // delivered. The worker is never told, and the mail is gone.
    const db = fakeDb()
    const first = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const different = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m3', 'm4'],
      now: 1_100
    })
    expect(different.operationId).not.toBe(first.operationId)
    expect(different.payloadFingerprint).toBe(first.payloadFingerprint)
  })

  it('re-mints when a retained batch is reordered or partly consumed', () => {
    const db = fakeDb()
    const first = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const shifted = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m2', 'm3'],
      now: 1_100
    })
    expect(shifted.operationId).not.toBe(first.operationId)
  })

  it('re-mints when the mailbox moves to a different session', () => {
    const db = fakeDb()
    const first = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const moved = resolveStructuredPointerOperation({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's2',
      body: body('2 messages'),
      messageIds: ['m1', 'm2'],
      now: 1_100
    })
    expect(moved.operationId).not.toBe(first.operationId)
  })
})
