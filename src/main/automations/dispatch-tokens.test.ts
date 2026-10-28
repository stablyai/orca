import { describe, expect, it, vi } from 'vitest'
import {
  beginAutomationDispatchTokenUse,
  createAutomationDispatchToken,
  getAutomationDispatchTokenCountForTests,
  MAX_AUTOMATION_DISPATCH_TOKENS
} from './dispatch-tokens'

describe('automation dispatch tokens', () => {
  it('bounds distinct token churn', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    try {
      const tokens = Array.from({ length: MAX_AUTOMATION_DISPATCH_TOKENS + 4 }, (_, index) => {
        const automationId = `automation-${index}`
        const runId = `run-${index}`
        return {
          automationId,
          runId,
          token: createAutomationDispatchToken(automationId, runId)
        }
      })

      expect(getAutomationDispatchTokenCountForTests()).toBe(MAX_AUTOMATION_DISPATCH_TOKENS)
      for (const token of tokens.slice(0, 4)) {
        expect(beginAutomationDispatchTokenUse({ ...token, reservationId: 'request-1' })).toBe(
          false
        )
      }
      for (const token of tokens.slice(4)) {
        expect(beginAutomationDispatchTokenUse({ ...token, reservationId: 'request-1' })).toBe(true)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
