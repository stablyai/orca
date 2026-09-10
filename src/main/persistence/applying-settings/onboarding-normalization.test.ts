import { describe, expect, it } from 'vitest'
import { normalizeNotificationSettings } from './onboarding-normalization'

describe('normalizeNotificationSettings agent notification mode', () => {
  it('defaults missing and invalid modes to legacy behavior', () => {
    expect(normalizeNotificationSettings({}).agentNotificationMode).toBe('all')
    expect(
      normalizeNotificationSettings({ agentNotificationMode: 'unexpected' }).agentNotificationMode
    ).toBe('all')
  })

  it('preserves the result-focused mode', () => {
    expect(
      normalizeNotificationSettings({ agentNotificationMode: 'results-and-actions' })
        .agentNotificationMode
    ).toBe('results-and-actions')
  })
})
