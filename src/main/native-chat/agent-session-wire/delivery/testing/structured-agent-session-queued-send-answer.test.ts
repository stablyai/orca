import { describe, expect, it, vi } from 'vitest'
import {
  applyJournalRow,
  createJournalReducerState
} from '../../../agent-session-journal/projection/journal-reducer'
import type { JournalReducerState } from '../../../agent-session-journal/projection/journal-reducer'
import { journalInputOrder } from '../../../agent-session-journal/input-order/journal-input-order'
import type { CommandReceiptRead } from '../../../agent-session-journal/writing/command-receipt-table'

import { parseJournalRow } from '../../../agent-session-journal/durable-rows/journal-row-schema'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredSendAnswer } from '../structured-agent-session-queued-send-answer'

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
})
