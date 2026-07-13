import { describe, expect, it } from 'vitest'
import type { RateLimitWindow } from '../../shared/rate-limit-types'
import {
  classifyCodexRateLimitWindows,
  isCodexWeeklyWindowDuration
} from './codex-rate-limit-window-classification'

function window(windowMinutes: number): RateLimitWindow {
  return {
    usedPercent: 25,
    windowMinutes,
    resetsAt: null,
    resetDescription: null
  }
}

describe('Codex rate-limit window classification', () => {
  it('recognizes exact and RPC-rounded weekly durations', () => {
    expect(isCodexWeeklyWindowDuration(10_080)).toBe(true)
    expect(isCodexWeeklyWindowDuration(10_079)).toBe(true)
    expect(isCodexWeeklyWindowDuration(300)).toBe(false)
  })

  it('classifies a sole weekly primary window as weekly', () => {
    const weekly = window(10_080)

    expect(classifyCodexRateLimitWindows(weekly, null)).toEqual({
      session: null,
      weekly
    })
  })

  it('keeps a sole five-hour primary window as the session limit', () => {
    const session = window(300)

    expect(classifyCodexRateLimitWindows(session, null)).toEqual({
      session,
      weekly: null
    })
  })

  it('keeps the traditional primary and secondary positions when both exist', () => {
    const session = window(300)
    const weekly = window(10_080)

    expect(classifyCodexRateLimitWindows(session, weekly)).toEqual({ session, weekly })
  })
})
