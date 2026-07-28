import { describe, expect, it } from 'vitest'
import {
  applyTerminalEditorTransaction,
  createTerminalEditorTransactionState,
  flushTerminalEditorTransaction
} from './terminal-editor-transaction-reconciler'

describe('terminal editor transaction reconciliation', () => {
  it('holds an ambiguous first ASCII edit until a later revision proves it stable', () => {
    const initial = createTerminalEditorTransactionState()
    const first = applyTerminalEditorTransaction(initial, {
      revision: 1,
      text: 's',
      composingStart: null,
      composingEnd: null
    })
    const second = applyTerminalEditorTransaction(first.state, {
      revision: 2,
      text: 'sa',
      composingStart: null,
      composingEnd: null
    })

    expect(first.bytes).toBe('')
    expect(second.bytes).toBe('s')
    expect(second.state.terminalText).toBe('s')
  })

  it('replaces a provisional Japanese key without leaking it to the terminal', () => {
    const initial = createTerminalEditorTransactionState()
    const provisional = applyTerminalEditorTransaction(initial, {
      revision: 1,
      text: 's',
      composingStart: null,
      composingEnd: null
    })
    const kana = applyTerminalEditorTransaction(provisional.state, {
      revision: 2,
      text: 'さ',
      composingStart: null,
      composingEnd: null
    })
    const nextProvisional = applyTerminalEditorTransaction(kana.state, {
      revision: 3,
      text: 'さk',
      composingStart: null,
      composingEnd: null
    })

    expect(provisional.bytes).toBe('')
    expect(kana.bytes).toBe('')
    expect(nextProvisional.bytes).toBe('さ')
    expect(nextProvisional.state.terminalText).toBe('さ')
  })

  it('holds the complete native composing range for Korean rewrites', () => {
    const initial = createTerminalEditorTransactionState()
    const composing = applyTerminalEditorTransaction(initial, {
      revision: 1,
      text: '한',
      composingStart: 0,
      composingEnd: 1
    })
    const extended = applyTerminalEditorTransaction(composing.state, {
      revision: 2,
      text: '한글',
      composingStart: 1,
      composingEnd: 2
    })

    expect(composing.bytes).toBe('')
    expect(extended.bytes).toBe('한')
  })

  it('does not erase an acknowledged prefix when only the held suffix is deleted', () => {
    let state = createTerminalEditorTransactionState()
    state = applyTerminalEditorTransaction(state, {
      revision: 1,
      text: 's',
      composingStart: null,
      composingEnd: null
    }).state
    state = applyTerminalEditorTransaction(state, {
      revision: 2,
      text: 'sa',
      composingStart: null,
      composingEnd: null
    }).state

    const deletedHeldSuffix = applyTerminalEditorTransaction(state, {
      revision: 3,
      text: 's',
      composingStart: null,
      composingEnd: null
    })

    expect(deletedHeldSuffix.bytes).toBe('')
    expect(deletedHeldSuffix.state.terminalText).toBe('s')
  })

  it('emits deliberate backspace only after an acknowledged grapheme is removed', () => {
    let state = createTerminalEditorTransactionState()
    state = applyTerminalEditorTransaction(state, {
      revision: 1,
      text: '👍🏽',
      composingStart: null,
      composingEnd: null
    }).state
    state = flushTerminalEditorTransaction(state).state

    const deleted = applyTerminalEditorTransaction(state, {
      revision: 2,
      text: '',
      composingStart: null,
      composingEnd: null
    })

    expect(deleted.bytes).toBe('\x7f')
    expect(deleted.state.terminalText).toBe('')
  })

  it('flushes the held grapheme without a timer before terminal Enter', () => {
    const pending = applyTerminalEditorTransaction(createTerminalEditorTransactionState(), {
      revision: 1,
      text: 'さ',
      composingStart: null,
      composingEnd: null
    })

    const flushed = flushTerminalEditorTransaction(pending.state)

    expect(flushed.bytes).toBe('さ')
    expect(flushed.state.terminalText).toBe('さ')
  })

  it('ignores duplicate and out-of-order native revisions', () => {
    const current = applyTerminalEditorTransaction(createTerminalEditorTransactionState(), {
      revision: 2,
      text: 'ab',
      composingStart: null,
      composingEnd: null
    })

    const stale = applyTerminalEditorTransaction(current.state, {
      revision: 1,
      text: 'x',
      composingStart: null,
      composingEnd: null
    })

    expect(stale).toEqual({ bytes: '', state: current.state })
  })
})
