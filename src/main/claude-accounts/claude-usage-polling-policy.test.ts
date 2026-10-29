import { describe, expect, it, vi } from 'vitest'
import {
  createClaudeUsagePollingSwitch,
  shouldPollClaudeUsage
} from './claude-usage-polling-policy'

describe('claude usage polling policy', () => {
  it('polls only while auto-switch is on', () => {
    expect(shouldPollClaudeUsage({ claudeAutoSwitchEnabled: false })).toBe(false)
    expect(shouldPollClaudeUsage({ claudeAutoSwitchEnabled: true })).toBe(true)
    expect(shouldPollClaudeUsage({})).toBe(false)
  })

  it('starts once, stops once, and ignores unrelated settings changes', () => {
    const rateLimits = { start: vi.fn(), stop: vi.fn() }
    let settings: { claudeAutoSwitchEnabled?: boolean } = { claudeAutoSwitchEnabled: false }
    const polling = createClaudeUsagePollingSwitch(rateLimits, () => settings)

    expect(polling.apply()).toBe(false)
    expect(rateLimits.start).not.toHaveBeenCalled()

    settings = { claudeAutoSwitchEnabled: true }
    expect(polling.apply({ claudeAutoSwitchEnabled: true })).toBe(true)
    expect(polling.apply({ claudeAutoSwitchEnabled: true })).toBe(true)
    expect(rateLimits.start).toHaveBeenCalledTimes(1)
    expect(rateLimits.start).toHaveBeenCalledWith({
      fetchImmediately: true,
      pollWithoutWindow: true
    })

    expect(polling.apply({})).toBe(true)
    expect(rateLimits.stop).not.toHaveBeenCalled()

    settings = { claudeAutoSwitchEnabled: false }
    expect(polling.apply({ claudeAutoSwitchEnabled: false })).toBe(false)
    expect(rateLimits.stop).toHaveBeenCalledTimes(1)
  })
})
