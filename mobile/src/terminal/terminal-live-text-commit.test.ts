import { describe, expect, it } from 'vitest'
import {
  TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS,
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText,
  getTerminalLiveDeferredTextDelayMs,
  getTerminalLiveSpecialKeyDecision,
  getTerminalLiveSubmitSequence,
  getTerminalLiveTextChangeDecision,
  isTerminalLiveTextHangulCandidate,
  isTerminalLiveTextImeCandidate
} from './terminal-live-text-commit'

describe('terminal live text commit', () => {
  it('Given Korean IME changes When live text changes Then defers candidates and submits only final text before carriage return', () => {
    // Given
    const koreanCompositionSteps = ['ㅎ', '하', '한'] as const

    // When
    const decisions = koreanCompositionSteps.map(getTerminalLiveTextChangeDecision)
    const sentImmediately = decisions.filter((decision) => decision.kind === 'send-now')
    const submitSequence = getTerminalLiveSubmitSequence('한')
    const composedWordDecision = getTerminalLiveTextChangeDecision('한글')
    const composedWordSubmitSequence = getTerminalLiveSubmitSequence('한글')

    // Then
    expect(decisions).toEqual([
      { kind: 'defer', text: 'ㅎ', delayMs: null },
      { kind: 'defer', text: '하', delayMs: null },
      { kind: 'defer', text: '한', delayMs: null }
    ])
    expect(sentImmediately).toEqual([])
    expect(isTerminalLiveTextHangulCandidate('ㅎ')).toBe(true)
    expect(getTerminalLiveDeferredTextDelayMs('ㅎ')).toBeNull()
    expect(submitSequence).toEqual(['한', '\r'])
    expect(composedWordDecision).toEqual({
      kind: 'defer',
      text: '한글',
      delayMs: null
    })
    expect(composedWordSubmitSequence).toEqual(['한글', '\r'])
  })

  it('Given non-Hangul IME text When live text changes Then keeps the bounded settle timer', () => {
    // Given
    const text = 'あ'

    // When
    const decision = getTerminalLiveTextChangeDecision(text)

    // Then
    expect(isTerminalLiveTextImeCandidate(text)).toBe(true)
    expect(isTerminalLiveTextHangulCandidate(text)).toBe(false)
    expect(getTerminalLiveDeferredTextDelayMs(text)).toBe(TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS)
    expect(decision).toEqual({ kind: 'defer', text, delayMs: TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS })
  })

  it('Given Chinese and Vietnamese IME text When live text changes Then does not use Hangul-only indefinite deferral', () => {
    // Given
    const nonHangulImeTexts = ['你好', 'tiếng Việt'] as const

    for (const text of nonHangulImeTexts) {
      // When
      const decision = getTerminalLiveTextChangeDecision(text)

      // Then
      expect(isTerminalLiveTextImeCandidate(text)).toBe(true)
      expect(isTerminalLiveTextHangulCandidate(text)).toBe(false)
      expect(getTerminalLiveDeferredTextDelayMs(text)).toBe(TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS)
      expect(decision).toEqual({
        kind: 'defer',
        text,
        delayMs: TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS
      })
    }
  })

  it('Given ASCII text When live text changes Then sends immediately', () => {
    // Given
    const text = 'abc123'

    // When
    const decision = getTerminalLiveTextChangeDecision(text)

    // Then
    expect(isTerminalLiveTextImeCandidate(text)).toBe(false)
    expect(decision).toEqual({ kind: 'send-now', text })
  })

  it('Given empty text When live text changes Then ignores the change', () => {
    // Given
    const text = ''

    // When
    const decision = getTerminalLiveTextChangeDecision(text)

    // Then
    expect(isTerminalLiveTextImeCandidate(text)).toBe(false)
    expect(decision).toEqual({ kind: 'ignore' })
  })

  it('Given pending text When Backspace or Delete is pressed Then keeps edits local', () => {
    // Given
    const pendingText = '한'

    // When
    const backspaceDecision = getTerminalLiveSpecialKeyDecision({ key: 'Backspace', pendingText })
    const deleteDecision = getTerminalLiveSpecialKeyDecision({ key: 'Delete', pendingText })

    // Then
    expect(backspaceDecision).toEqual({ kind: 'local-edit' })
    expect(deleteDecision).toEqual({ kind: 'local-edit' })
  })

  it('Given no pending text When Backspace or Delete is pressed Then sends terminal bytes', () => {
    // Given
    const pendingText = ''

    // When
    const backspaceDecision = getTerminalLiveSpecialKeyDecision({ key: 'Backspace', pendingText })
    const deleteDecision = getTerminalLiveSpecialKeyDecision({ key: 'Delete', pendingText })

    // Then
    expect(backspaceDecision).toEqual({ kind: 'send-now', bytes: '\x7f' })
    expect(deleteDecision).toEqual({ kind: 'send-now', bytes: '\x1b[3~' })
  })

  it('Given pending text When a terminal special key is pressed Then flushes pending text before bytes', () => {
    // Given
    const pendingText = '한'

    // When
    const decision = getTerminalLiveSpecialKeyDecision({ key: 'Tab', pendingText })

    // Then
    expect(decision).toEqual({ kind: 'flush-then-send', pendingText, bytes: '\t' })
  })

  it('Given pending text When accessory control bytes are requested Then flushes pending text before bytes', () => {
    // Given
    const pendingText = '한글'

    // When
    const tabDecision = getTerminalLiveAccessoryBytesDecision({ bytes: '\t', pendingText })
    const escapeDecision = getTerminalLiveAccessoryBytesDecision({ bytes: '\x1b', pendingText })
    const enterDecision = getTerminalLiveAccessoryBytesDecision({ bytes: '\r', pendingText })

    // Then
    expect(tabDecision).toEqual({ kind: 'flush-then-send', pendingText, bytes: '\t' })
    expect(escapeDecision).toEqual({ kind: 'flush-then-send', pendingText, bytes: '\x1b' })
    expect(enterDecision).toEqual({ kind: 'flush-then-send', pendingText, bytes: '\r' })
  })

  it('Given pending text When accessory Backspace or Delete bytes are requested Then keeps edits local', () => {
    // Given
    const pendingText = '한글'

    // When
    const backspaceDecision = getTerminalLiveAccessoryBytesDecision({
      bytes: '\x7f',
      localEdit: 'backspace',
      pendingText
    })
    const ctrlBackspaceDecision = getTerminalLiveAccessoryBytesDecision({
      bytes: '\b',
      localEdit: 'backspace',
      pendingText
    })
    const deleteDecision = getTerminalLiveAccessoryBytesDecision({
      bytes: '\x1b[3~',
      localEdit: 'delete',
      pendingText
    })
    const customDeleteByteDecision = getTerminalLiveAccessoryBytesDecision({
      bytes: '\x7f',
      pendingText
    })
    const backspaceText = getTerminalLiveAccessoryLocalEditText({
      localEdit: 'backspace',
      pendingText
    })
    const deleteText = getTerminalLiveAccessoryLocalEditText({
      localEdit: 'delete',
      pendingText
    })

    // Then
    expect(backspaceDecision).toEqual({ kind: 'local-edit', localEdit: 'backspace' })
    expect(ctrlBackspaceDecision).toEqual({ kind: 'local-edit', localEdit: 'backspace' })
    expect(deleteDecision).toEqual({ kind: 'local-edit', localEdit: 'delete' })
    expect(customDeleteByteDecision).toEqual({
      kind: 'flush-then-send',
      pendingText,
      bytes: '\x7f'
    })
    expect(backspaceText).toBe('한')
    expect(deleteText).toBe('한글')
    expect(getTerminalLiveDeferredTextDelayMs(backspaceText)).toBeNull()
    expect(getTerminalLiveDeferredTextDelayMs(deleteText)).toBeNull()
  })

  it('Given no pending text When accessory bytes are requested Then sends terminal bytes', () => {
    // Given
    const pendingText = ''

    // When
    const tabDecision = getTerminalLiveAccessoryBytesDecision({ bytes: '\t', pendingText })

    // Then
    expect(tabDecision).toEqual({ kind: 'send-now', bytes: '\t' })
  })

  it('Given a non-special key When key decision is requested Then ignores it', () => {
    // Given
    const key = 'a'

    // When
    const decision = getTerminalLiveSpecialKeyDecision({ key, pendingText: '한' })

    // Then
    expect(decision).toEqual({ kind: 'ignore' })
  })

  it('Given no pending text When submit is requested Then sends only carriage return', () => {
    // Given
    const pendingText = ''

    // When
    const sequence = getTerminalLiveSubmitSequence(pendingText)

    // Then
    expect(sequence).toEqual(['\r'])
  })
})
