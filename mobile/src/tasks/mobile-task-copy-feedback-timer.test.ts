import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearMobileTaskCopyFeedbackTimer,
  scheduleMobileTaskCopyFeedbackReset,
  type MobileTaskCopyFeedbackTimerRef
} from './mobile-task-copy-feedback-timer'

function createTimerRef(): MobileTaskCopyFeedbackTimerRef {
  return { current: null }
}

function createCopiedKeyState(initial: string | null) {
  let value = initial
  return {
    get value() {
      return value
    },
    setCopiedKey(updater: (current: string | null) => string | null) {
      value = updater(value)
    }
  }
}

describe('mobile task copy feedback timer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the copied key only when the scheduled key is still current', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const copied = createCopiedKeyState('task:one')

    scheduleMobileTaskCopyFeedbackReset(timerRef, 'task:one', copied.setCopiedKey)
    copied.setCopiedKey(() => 'task:two')
    vi.runOnlyPendingTimers()

    expect(copied.value).toBe('task:two')
    expect(timerRef.current).toBeNull()
  })

  it('replaces stale copy feedback timers', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const copied = createCopiedKeyState('task:one')

    scheduleMobileTaskCopyFeedbackReset(timerRef, 'task:one', copied.setCopiedKey)
    copied.setCopiedKey(() => 'task:two')
    scheduleMobileTaskCopyFeedbackReset(timerRef, 'task:two', copied.setCopiedKey)
    vi.runOnlyPendingTimers()

    expect(copied.value).toBeNull()
    expect(timerRef.current).toBeNull()
  })

  it('cancels pending copy feedback work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const copied = createCopiedKeyState('task:one')

    scheduleMobileTaskCopyFeedbackReset(timerRef, 'task:one', copied.setCopiedKey)
    clearMobileTaskCopyFeedbackTimer(timerRef)
    vi.runOnlyPendingTimers()

    expect(copied.value).toBe('task:one')
    expect(timerRef.current).toBeNull()
  })
})
