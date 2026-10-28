import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetValidatorWarnCacheForTests, validate } from './validator'

describe('validate', () => {
  beforeEach(() => {
    _resetValidatorWarnCacheForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drops unknown event names', () => {
    const result = validate('not_a_real_event' as never, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/unknown event/)
    }
  })
})
