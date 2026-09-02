import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mobileNativeChatQuestionOffsets,
  scheduleMobileClaudeAnswer,
  MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS,
  MOBILE_NATIVE_CHAT_QUESTION_STEP_MS,
  MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS
} from './mobile-native-chat-answer-stepping'

describe('mobileNativeChatQuestionOffsets', () => {
  it('matches the desktop cadence constants', () => {
    expect(MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS).toBe(500)
    expect(MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS).toBe(500)
    expect(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS).toBe(1000)
  })

  it('paces each question a full step apart, Enter 500ms after its body', () => {
    expect(mobileNativeChatQuestionOffsets(0)).toEqual({ bodyAt: 0, enterAt: 500 })
    expect(mobileNativeChatQuestionOffsets(1)).toEqual({ bodyAt: 1000, enterAt: 1500 })
    expect(mobileNativeChatQuestionOffsets(2)).toEqual({ bodyAt: 2000, enterAt: 2500 })
  })
})

describe('scheduleMobileClaudeAnswer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('writes each question body then its Enter, paced per step, one Enter per line', () => {
    const events: string[] = []
    const timers = scheduleMobileClaudeAnswer(
      ['', 'b', 'c'], // blank middle answer must still get its own body + Enter
      (line) => events.push(`body:${line}`),
      () => events.push('enter')
    )
    expect(timers).toHaveLength(6)

    vi.advanceTimersByTime(0)
    expect(events).toEqual(['body:'])
    vi.advanceTimersByTime(MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(events).toEqual(['body:', 'enter'])
    vi.advanceTimersByTime(MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS)
    expect(events).toEqual(['body:', 'enter', 'body:b'])

    vi.runAllTimers()
    expect(events).toEqual(['body:', 'enter', 'body:b', 'enter', 'body:c', 'enter'])
  })

  it('cancelling the returned timers stops all pending writes', () => {
    const events: string[] = []
    const timers = scheduleMobileClaudeAnswer(
      ['a', 'b'],
      (line) => events.push(`body:${line}`),
      () => events.push('enter')
    )
    for (const timer of timers) {
      clearTimeout(timer)
    }
    vi.runAllTimers()
    expect(events).toEqual([])
  })
})
