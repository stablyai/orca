import { describe, expect, it, vi } from 'vitest'
import {
  applyJournalRow,
  createJournalReducerState
} from '../agent-session-journal/journal-reducer'
import type { JournalReducerState } from '../agent-session-journal/journal-reducer'
import { journalInputOrder } from '../agent-session-journal/journal-input-order'
import type { CommandReceiptRead } from '../agent-session-journal/command-receipt-table'
import type { CommandReceipt } from '../agent-session-journal/command-receipt-schema'
import { structuredSendAnswer } from './structured-agent-session-queued-send-answer'

const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'work' }] }

/** A journal as the reducer folds it, with the host's own readers over it. */
function journal() {
  const state = createJournalReducerState('session-1', 'epoch')
  const at = (seq: number) => ({ epoch: 'epoch', seq, ts: seq, fence: 1 })
  const row = (value: Record<string, unknown>) => applyJournalRow(state, value as never)
  return {
    state,
    submit: (seq: number, id: string, queuedMessageId?: string) =>
      row({
        ...at(seq),
        kind: 'submission',
        clientMessageId: id,
        payloadFingerprint: id,
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
  const reads = {
    submission: (id: string) => state.submissions.get(id),
    item: (id: string) => state.items.get(id),
    inputOrder: journalInputOrder(state),
    queuedMessages: {
      get: (id: string) => state.queue.cards.get(id) ?? null,
      inputState: () => state
    },
    // Following sends never walks the conversation's history.
    submissions: () => {
      throw new Error('a send answer read the whole history')
    }
  }
  return {
    result: structuredSendAnswer(reads as never, readReceipt, 'session-1', operationId),
    readReceipt
  }
}

function receipt(status: 'accepted' | 'rejected'): CommandReceiptRead {
  return {
    verdict: 'readable',
    receipt: {
      operationId: 'mail',
      sessionId: 'session-1',
      status,
      method: 'agentSession.send',
      ...(status === 'accepted'
        ? { result: { kind: 'journal-row', epoch: 'old', sequence: 1 } }
        : { rejection: { reference: { code: 'agent_session_conflict' } } })
    } as unknown as CommandReceipt
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

  it.each([
    ['nothing recorded proves it was never admitted', { verdict: 'absent' }, 'absent'],
    ['an unreadable receipt proves nothing', { verdict: 'unreadable' }, 'unreadable'],
    // History replaced since: the admission stands, whatever its id's age.
    ['an admission whose journal detail is gone stays in doubt', receipt('accepted'), 'unknown'],
    ['a refusal before admission is not in doubt', receipt('rejected'), 'refused']
  ] as const)('%s', (_label, read, kind) => {
    const { result, readReceipt } = answer(journal().state, 'mail', read as CommandReceiptRead)
    expect(result).toEqual({ kind })
    expect(readReceipt).toHaveBeenCalledWith('mail')
  })

  it.each([4, 40])('answers %i sends with no card left by key, over a long history', (count) => {
    const j = journal()
    for (let item = 0; item < 500; item += 1) {
      j.submit(item * 3 + 1, `history-${item}`)
      j.handOver(item * 3 + 2, `history-${item}`)
      j.accept(item * 3 + 3, `history-${item}`)
    }
    let receipts = 0
    for (let send = 0; send < count; send += 1) {
      const { result, readReceipt } = answer(j.state, `gone-${send}`)
      expect(result).toEqual({ kind: 'absent' })
      receipts += readReceipt.mock.calls.length
    }
    // One receipt read per send, and no history walk (the reader above throws on one).
    expect(receipts).toBe(count)
  })
})
