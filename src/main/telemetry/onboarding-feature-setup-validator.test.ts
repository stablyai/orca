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

  it('accepts checklist, setup run, and terminal interaction events', () => {
    const selection = {
      browser_use: true,
      computer_use: false,
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
          skill_commands_copied: true,
          skill_install_command_prepared: true,
          computer_use_permissions_opened: false,
          warning_count: 0
        }
      ],
      ['onboarding_feature_setup_terminal_opened', selection],
      ['onboarding_feature_setup_terminal_interacted', { ...selection, method: 'keyboard' }]
    ] as const

    for (const [event, props] of cases) {
      expect(validate(event, props).ok).toBe(true)
    }
  })

  it('rejects raw strings and unknown fields', () => {
    expect(
      validate('onboarding_feature_setup_terminal_opened', {
        browser_use: true,
        computer_use: false,
        orchestration: true,
        selected_count: 2,
        command: 'npx skills add https://github.com/stablyai/orca --global'
      } as never).ok
    ).toBe(false)
    expect(
      validate('onboarding_feature_setup_toggled', {
        feature: 'browser_use',
        selected: false,
        path: '/Users/alice/project'
      } as never).ok
    ).toBe(false)
  })

  it('rejects selected_count values that do not match selected features', () => {
    expect(
      validate('onboarding_feature_setup_run', {
        browser_use: false,
        computer_use: false,
        orchestration: false,
        selected_count: 3,
        cli_touched: false,
        skill_commands_copied: false,
        skill_install_command_prepared: false,
        computer_use_permissions_opened: false,
        warning_count: 0
      } as never).ok
    ).toBe(false)
    expect(
      validate('onboarding_feature_setup_terminal_opened', {
        browser_use: true,
        computer_use: false,
        orchestration: true,
        selected_count: 1
      } as never).ok
    ).toBe(false)
  })
})
