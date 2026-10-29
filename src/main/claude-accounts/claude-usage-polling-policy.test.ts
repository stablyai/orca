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

  it('takes one viewer, releases it once, and ignores unrelated settings changes', () => {
    const release = vi.fn()
    const rateLimits = {
      addUsageViewer: vi.fn(() => release),
      refreshIfStale: vi.fn(async () => undefined)
    }
    let settings: { claudeAutoSwitchEnabled?: boolean } = { claudeAutoSwitchEnabled: false }
    const polling = createClaudeUsagePollingSwitch(rateLimits, () => settings)

    expect(polling.apply()).toBe(false)
    expect(rateLimits.addUsageViewer).not.toHaveBeenCalled()

    settings = { claudeAutoSwitchEnabled: true }
    expect(polling.apply({ claudeAutoSwitchEnabled: true })).toBe(true)
    expect(polling.apply({ claudeAutoSwitchEnabled: true })).toBe(true)
    expect(rateLimits.addUsageViewer).toHaveBeenCalledTimes(1)
    expect(rateLimits.refreshIfStale).toHaveBeenCalledTimes(1)

    expect(polling.apply({ theme: 'dark' })).toBe(true)
    expect(release).not.toHaveBeenCalled()

    settings = { claudeAutoSwitchEnabled: false }
    expect(polling.apply({ claudeAutoSwitchEnabled: false })).toBe(false)
    expect(polling.apply({ claudeAutoSwitchEnabled: false })).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
