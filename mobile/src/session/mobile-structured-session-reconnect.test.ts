import { describe, expect, it } from 'vitest'
import {
  createMobileStructuredReconnectState,
  noteStructuredBackground,
  noteStructuredStreamClosed,
  noteStructuredStreamOpened,
  resumeStructuredSession
} from './mobile-structured-session-reconnect'

describe('mobile structured reconnect supervision', () => {
  it('replaces only a socket backgrounded for at least ten seconds and skips rung zero', () => {
    const state = createMobileStructuredReconnectState()
    noteStructuredBackground(state, 1_000)
    expect(resumeStructuredSession(state, 10_999).reconnect).toBe(false)
    noteStructuredBackground(state, 20_000)
    expect(resumeStructuredSession(state, 30_000)).toEqual({
      reconnect: true,
      minimumBackoffAttempt: 1
    })
  })

  it('counts background duration from the first inactive transition', () => {
    const state = createMobileStructuredReconnectState()
    noteStructuredBackground(state, 1_000)
    noteStructuredBackground(state, 5_000)

    expect(resumeStructuredSession(state, 11_000).reconnect).toBe(true)
  })

  it('resets backoff only after more than five seconds of stream longevity', () => {
    const state = createMobileStructuredReconnectState()
    noteStructuredStreamOpened(state, 0)
    noteStructuredStreamClosed(state, 5_000)
    expect(state.backoffAttempt).toBe(1)
    noteStructuredStreamOpened(state, 10_000)
    noteStructuredStreamClosed(state, 15_001)
    expect(state.backoffAttempt).toBe(0)
  })
})
