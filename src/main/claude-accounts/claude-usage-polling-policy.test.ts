import { describe, expect, it, vi } from 'vitest'
import {
  createClaudeUsagePollingSwitch,
  shouldPollClaudeUsage
} from './claude-usage-polling-policy'

describe('claude usage polling policy', () => {
  it('polls when auto-switch or the mover needs readings', () => {
    expect(
      shouldPollClaudeUsage({ claudeAutoSwitchEnabled: false, claudeSessionMover: 'off' })
    ).toBe(false)
    expect(
      shouldPollClaudeUsage({ claudeAutoSwitchEnabled: true, claudeSessionMover: 'off' })
    ).toBe(true)
    expect(
      shouldPollClaudeUsage({ claudeAutoSwitchEnabled: false, claudeSessionMover: 'move' })
    ).toBe(true)
    expect(
      shouldPollClaudeUsage({
        claudeAutoSwitchEnabled: false,
        claudeSessionMover: 'off',
        claudeAccountPool: 'on'
      })
    ).toBe(true)
    expect(
      shouldPollClaudeUsage({
        claudeAutoSwitchEnabled: false,
        claudeSessionMover: 'off',
        claudeAccountPool: 'off'
      })
    ).toBe(false)
    // Absent means 'ask', which on a headless host acts as 'move'.
    expect(shouldPollClaudeUsage({})).toBe(true)
  })

  it('takes one viewer, releases it once, and ignores unrelated settings changes', () => {
    const release = vi.fn()
    const rateLimits = {
      addUsageViewer: vi.fn(() => release),
      refreshIfStale: vi.fn(async () => undefined)
    }
    let settings: {
      claudeAutoSwitchEnabled?: boolean
      claudeSessionMover?: 'off' | 'ask' | 'move'
    } = { claudeSessionMover: 'off' }
    const polling = createClaudeUsagePollingSwitch(rateLimits, () => settings)

    expect(polling.apply()).toBe(false)
    expect(rateLimits.addUsageViewer).not.toHaveBeenCalled()

    settings = { claudeSessionMover: 'move' }
    expect(polling.apply({ claudeSessionMover: 'move' })).toBe(true)
    expect(polling.apply({ claudeSessionMover: 'move' })).toBe(true)
    expect(rateLimits.addUsageViewer).toHaveBeenCalledTimes(1)
    expect(rateLimits.refreshIfStale).toHaveBeenCalledTimes(1)

    expect(polling.apply({ theme: 'dark' })).toBe(true)
    expect(release).not.toHaveBeenCalled()

    settings = { claudeSessionMover: 'off', claudeAutoSwitchEnabled: false }
    expect(polling.apply({ claudeSessionMover: 'off' })).toBe(false)
    expect(polling.apply({ claudeSessionMover: 'off' })).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
