// A dispatch row written before the write-side reason bound (#20654) still carries the provider's
// full error text; the submission every page and frame attaches must read it bounded.

import { describe, expect, it } from 'vitest'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import type { JournalRow } from './journal-row-schema'

const EPOCH = 'epoch-1'

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

function reasonAfter(reason: string | null) {
  const state = createJournalReducerState('session-1', EPOCH)
  applyJournalRow(state, {
    kind: 'submission',
    clientMessageId: 'cm_1',
    payloadFingerprint: 'fp_1',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...base(1)
  })
  const dispatch: JournalRow = {
    kind: 'dispatch',
    clientMessageId: 'cm_1',
    state: 'rejected',
    providerItemId: null,
    reason,
    ...base(2)
  }
  applyJournalRow(state, dispatch)
  return state.submissions.get('cm_1')?.reason
}

describe("a dispatch row's reason", () => {
  it('reads bounded, head first, when an older build stored megabytes of it', () => {
    const reason = reasonAfter(`Write failed: ${'x'.repeat(4 * 1024 * 1024)}`)

    expect(reason?.startsWith('Write failed: ')).toBe(true)
    expect(reason).toContain('[Orca: output truncated')
    expect(Buffer.byteLength(reason ?? '')).toBeLessThan(
      DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes + 1024
    )
  })

  it('reads as stored when it already fits, or is absent', () => {
    expect(reasonAfter('Provider rejected the message.')).toBe('Provider rejected the message.')
    expect(reasonAfter(null)).toBeNull()
  })
})
