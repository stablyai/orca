import { describe, expect, it, vi } from 'vitest'
import {
  applyJournalRow,
  createJournalReducerState
} from '../agent-session-journal/journal-reducer'
import type { JournalReducerState } from '../agent-session-journal/journal-reducer'
import { journalInputOrder } from '../agent-session-journal/journal-input-order'
import type { CommandReceiptRead } from '../agent-session-journal/command-receipt-table'
import { commandReceiptSchema } from '../agent-session-journal/command-receipt-schema'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  structuredSendAnswer,
  type StructuredSendAnswer
} from './structured-agent-session-queued-send-answer'

const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'work' }] }

/** A journal as the reducer folds it, with the host's own readers over it. */
function journal() {
  const state = createJournalReducerState('session-1', 'epoch')
  const at = (seq: number) => ({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch',
    seq,
    ts: seq,
    fence: 1
  })
  // Each row as the journal reads it back from disk, so a malformed fixture fails here.
  const row = (value: Record<string, unknown>) => {
    const parsed = parseJournalRow(JSON.stringify(value))
    if (!parsed.ok) {
      throw new Error(`unreadable journal row: ${JSON.stringify(value)}`)
    }
    applyJournalRow(state, parsed.row)
  }
  return {
    state,
    submit: (seq: number, id: string, queuedMessageId?: string) =>
      row({
        ...at(seq),
        kind: 'submission',
        clientMessageId: id,
        payloadFingerprint: id,
        providerHandle: { kind: 'codex', threadId: 'thread' },
        body,
        handoverRecorded: true,
        ...(queuedMessageId && { queuedMessageId })
      }),
    handOver: (seq: number, id: string) =>
      row({
        ...at(seq),
        kind: 'dispatch',
        clientMessageId: id,
        state: 'pending',
        providerItemId: null,
        reason: null,
        turnScope: { kind: 'thread' }
      }),
    accept: (seq: number, id: string) =>
      row({
        ...at(seq),
        kind: 'dispatch',
        clientMessageId: id,
        state: 'accepted',
        providerItemId: `echo-${id}`,
        reason: null
      }),
    reject: (seq: number, id: string) =>
      row({
        ...at(seq),
        kind: 'dispatch',
        clientMessageId: id,
        state: 'rejected',
        providerItemId: null,
        reason: 'unavailable',
        rejection: { kind: 'providerUnavailable' }
      })
  }
}

function answer(
  state: JournalReducerState,
  operationId: string,
  receipt: CommandReceiptRead = { verdict: 'absent' }
) {
  const readReceipt = vi.fn((_operationId: string) => receipt)
  const reads: Parameters<typeof structuredSendAnswer>[0] = {
    submission: (id) => state.submissions.get(id),
    item: (id) => state.items.get(id) ?? null,
    inputOrder: journalInputOrder(state),
    queuedMessages: {
      get: (id) => state.queue.cards.get(id) ?? null,
      inputState: () => state
    }
  }
  // Following sends never walks the conversation's history.
  const guarded = {
    ...reads,
    submissions: () => {
      throw new Error('a send answer read the whole history')
    }
  }
  return {
    result: structuredSendAnswer(guarded, readReceipt, 'session-1', operationId),
    readReceipt
  }
}

function receipt(status: 'accepted' | 'rejected'): CommandReceiptRead {
  return {
    verdict: 'readable',
    // Parsed as the receipt table reads a saved row.
    receipt: commandReceiptSchema.parse({
      operationId: 'mail',
      sessionId: 'session-1',
      callerKey: 'client',
      method: 'agentSession.send',
      fingerprint: 'f'.repeat(64),
      acceptedAt: 1,
      status,
      ...(status === 'accepted'
        ? { result: { kind: 'journal-row', epoch: 'old', sequence: 1 } }
        : { rejection: { reference: { code: 'agent_session_conflict' } } })
    })
  }
}

describe('what a chat host answers for one send', () => {
  it('counts a later turn by where it was handed over, not where it was admitted', () => {
    const j = journal()
    j.submit(1, 'mail')
    // The person's message is admitted before the mail fails, and handed over after.
    j.submit(2, 'person')
    j.reject(3, 'mail')
    j.handOver(4, 'person')
    j.accept(5, 'person')
    expect(answer(j.state, 'mail').result).toEqual({
      kind: 'rejected',
      cancelled: false,
      recovered: true
    })
  })

  it('never counts a turn handed over before the failure, though accepted after it', () => {
    const j = journal()
    j.submit(1, 'mail')
    j.submit(2, 'person')
    j.handOver(3, 'person')
    j.reject(4, 'mail')
    j.accept(5, 'person')
    expect(answer(j.state, 'mail').result).toMatchObject({ kind: 'rejected', recovered: false })
  })

  it('answers a gone card from its latest handoff, by key', () => {
    const j = journal()
    j.submit(1, 'handoff-1', 'card')
    j.handOver(2, 'handoff-1')
    j.accept(3, 'handoff-1')
    expect(answer(j.state, 'card').result).toEqual({ kind: 'accepted' })
  })

  const receiptCases: [string, CommandReceiptRead, StructuredSendAnswer['kind']][] = [
    ['nothing recorded proves it was never admitted', { verdict: 'absent' }, 'absent'],
    [
      'an unreadable receipt proves nothing',
      { verdict: 'unreadable', scope: { kind: 'global' }, operationId: 'mail' },
      'unreadable'
    ],
    // History replaced since: the admission stands, whatever its id's age.
    ['an admission whose journal detail is gone stays in doubt', receipt('accepted'), 'unknown'],
    ['a refusal before admission is not in doubt', receipt('rejected'), 'refused']
  ]
  it.each(receiptCases)('%s', (_label, read, kind) => {
    const { result, readReceipt } = answer(journal().state, 'mail', read)
    expect(result).toEqual({ kind })
    expect(readReceipt).toHaveBeenCalledWith('mail')
  })
})
