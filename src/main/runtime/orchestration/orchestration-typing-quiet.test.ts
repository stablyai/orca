import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_TYPING_QUIET_MS,
  remainingOrchestrationTypingQuietMs,
  shouldDeferOrchestrationTypingQuiet
} from './orchestration-typing-quiet'

describe('orchestration typing quiet (#14832)', () => {
  const now = 10_000

  it('does not defer when the Orca window is unfocused', () => {
    expect(
      remainingOrchestrationTypingQuietMs({
        lastUserInputAt: now - 100,
        now,
        windowFocused: false
      })
    ).toBe(0)
    expect(
      shouldDeferOrchestrationTypingQuiet({
        lastUserInputAt: now - 100,
        now,
        windowFocused: false
      })
    ).toBe(false)
  })

  it('does not defer when this PTY has no recent user input', () => {
    expect(
      remainingOrchestrationTypingQuietMs({
        lastUserInputAt: undefined,
        now,
        windowFocused: true
      })
    ).toBe(0)
  })

  it('defers while this PTY had user input inside the 5s window and the window is focused', () => {
    expect(
      remainingOrchestrationTypingQuietMs({
        lastUserInputAt: now - 1_200,
        now,
        windowFocused: true
      })
    ).toBe(ORCHESTRATION_TYPING_QUIET_MS - 1_200)
    expect(
      shouldDeferOrchestrationTypingQuiet({
        lastUserInputAt: now - 1_200,
        now,
        windowFocused: true
      })
    ).toBe(true)
  })

  it('does not defer after the 5s quiet window', () => {
    expect(
      remainingOrchestrationTypingQuietMs({
        lastUserInputAt: now - ORCHESTRATION_TYPING_QUIET_MS,
        now,
        windowFocused: true
      })
    ).toBe(0)
    expect(
      remainingOrchestrationTypingQuietMs({
        lastUserInputAt: now - ORCHESTRATION_TYPING_QUIET_MS - 1,
        now,
        windowFocused: true
      })
    ).toBe(0)
  })
})
