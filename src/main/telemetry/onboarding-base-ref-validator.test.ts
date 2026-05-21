import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetValidatorWarnCacheForTests, validate } from './validator'

describe('onboarding base-ref picker telemetry validation', () => {
  beforeEach(() => {
    _resetValidatorWarnCacheForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts picker events with cohort injected', () => {
    expect(
      validate('onboarding_base_ref_picker_shown', {
        path: 'open_folder',
        cohort: 'fresh_install'
      }).ok
    ).toBe(true)
    expect(
      validate('onboarding_base_ref_picker_completed', {
        path: 'clone_url',
        cohort: 'upgrade_backfill'
      }).ok
    ).toBe(true)
  })

  it('rejects raw base-ref picker payload fields', () => {
    const result = validate('onboarding_base_ref_picker_completed', {
      path: 'open_folder',
      branch: 'origin/customer-main'
    } as never)

    expect(result.ok).toBe(false)
  })
})
