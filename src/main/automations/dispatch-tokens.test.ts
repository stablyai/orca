import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _getAutomationDispatchTokenCountForTests,
  _resetAutomationDispatchTokensForTests,
  beginAutomationDispatchTokenUse,
  clearAutomationDispatchTokens,
  createAutomationDispatchToken,
  DISPATCH_TOKEN_MAX_ENTRIES,
  finishAutomationDispatchTokenUse,
  releaseAutomationDispatchTokenUse
} from './dispatch-tokens'

beforeEach(() => {
  _resetAutomationDispatchTokensForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automation dispatch tokens', () => {
  it('preserves reservation, release, and one-time finish behavior', () => {
    const token = createAutomationDispatchToken('automation', 'run')
    const args = { token, automationId: 'automation', runId: 'run', reservationId: 'request-1' }

    expect(beginAutomationDispatchTokenUse(args)).toBe(true)
    expect(beginAutomationDispatchTokenUse(args)).toBe(false)
    releaseAutomationDispatchTokenUse({ token, reservationId: 'request-1' })
    expect(beginAutomationDispatchTokenUse(args)).toBe(true)
    finishAutomationDispatchTokenUse({ token, reservationId: 'request-1' })
    expect(beginAutomationDispatchTokenUse(args)).toBe(false)
  })

  it('keeps delimiter-containing identities distinct', () => {
    const token = createAutomationDispatchToken('a:b', 'c')
    expect(
      beginAutomationDispatchTokenUse({
        token,
        automationId: 'a',
        runId: 'b:c',
        reservationId: 'request'
      })
    ).toBe(false)
  })

  it('clears only the matching automation run', () => {
    const removed = createAutomationDispatchToken('automation', 'run-1')
    const retained = createAutomationDispatchToken('automation', 'run-2')
    clearAutomationDispatchTokens('automation', 'run-1')

    expect(
      beginAutomationDispatchTokenUse({
        token: removed,
        automationId: 'automation',
        runId: 'run-1',
        reservationId: 'request'
      })
    ).toBe(false)
    expect(
      beginAutomationDispatchTokenUse({
        token: retained,
        automationId: 'automation',
        runId: 'run-2',
        reservationId: 'request'
      })
    ).toBe(true)
  })

  it('physically prunes expired records', () => {
    vi.useFakeTimers()
    const expired = createAutomationDispatchToken('automation', 'old')
    vi.advanceTimersByTime(30 * 60_000 + 1)
    createAutomationDispatchToken('automation', 'new')

    expect(_getAutomationDispatchTokenCountForTests()).toBe(1)
    expect(
      beginAutomationDispatchTokenUse({
        token: expired,
        automationId: 'automation',
        runId: 'old',
        reservationId: 'request'
      })
    ).toBe(false)
  })

  it('evicts the oldest unused token at the entry cap', () => {
    const oldest = createAutomationDispatchToken('automation', 'run-0')
    for (let index = 1; index <= DISPATCH_TOKEN_MAX_ENTRIES; index += 1) {
      createAutomationDispatchToken('automation', `run-${index}`)
    }

    expect(_getAutomationDispatchTokenCountForTests()).toBe(DISPATCH_TOKEN_MAX_ENTRIES)
    expect(
      beginAutomationDispatchTokenUse({
        token: oldest,
        automationId: 'automation',
        runId: 'run-0',
        reservationId: 'request'
      })
    ).toBe(false)
  })
})
