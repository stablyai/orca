import { describe, expect, it } from 'vitest'
import {
  TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS,
  getTerminalLiveSpecialKeyDecision,
  getTerminalLiveSubmitSequence,
  getTerminalLiveTextChangeDecision,
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

    // Then
    expect(decisions).toEqual([
      { kind: 'defer', text: 'ㅎ', delayMs: TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS },
      { kind: 'defer', text: '하', delayMs: TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS },
      { kind: 'defer', text: '한', delayMs: TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS }
    ])
    expect(sentImmediately).toEqual([])
    expect(submitSequence).toEqual(['한', '\r'])
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
