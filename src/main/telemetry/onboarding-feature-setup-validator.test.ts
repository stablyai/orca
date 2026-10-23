import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetValidatorWarnCacheForTests, validate } from './validator'

describe('onboarding feature setup telemetry validation', () => {
  beforeEach(() => {
    _resetValidatorWarnCacheForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts checklist and setup run events', () => {
    const selection = {
      browser_use: true,
      computer_use: false,
      linear_tickets: true,
      orchestration: true,
      selected_count: 2
    }
    const cases = [
      ['onboarding_feature_setup_toggled', { feature: 'browser_use', selected: false }],
      [
        'onboarding_feature_setup_run',
        {
          ...selection,
          cli_touched: true,
          skill_install_result: 'needs_attention',
          computer_use_permissions_opened: false,
          warning_count: 0
        }
      ]
    ] as const

    for (const [event, props] of cases) {
      expect(validate(event, props).ok).toBe(true)
    }
  })

  it('rejects raw strings and unknown fields', () => {
    expect(
      validate('onboarding_feature_setup_toggled', {
        feature: 'browser_use',
        selected: false,
        path: '/Users/alice/project'
      }).ok
    ).toBe(false)
    expect(
      validate('onboarding_feature_setup_run', {
        browser_use: true,
        computer_use: false,
        linear_tickets: false,
        orchestration: false,
        selected_count: 1,
        cli_touched: false,
        skill_install_result: 'Installed · 1 left alone',
        computer_use_permissions_opened: false,
        warning_count: 0
      }).ok
    ).toBe(false)
  })

  it('rejects selected_count values that do not match selected features', () => {
    expect(
      validate('onboarding_feature_setup_run', {
        browser_use: false,
        computer_use: false,
        linear_tickets: false,
        orchestration: false,
        selected_count: 3,
        cli_touched: false,
        skill_install_result: 'installed',
        computer_use_permissions_opened: false,
        warning_count: 0
      }).ok
    ).toBe(false)
  })
})
