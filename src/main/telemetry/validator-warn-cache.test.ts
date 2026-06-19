import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _getValidatorWarnCacheSizeForTests,
  _resetValidatorWarnCacheForTests,
  validate
} from './validator'

describe('telemetry validator warn cache', () => {
  beforeEach(() => {
    _resetValidatorWarnCacheForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('bounds warn rate-limit entries for unique invalid event names', () => {
    for (let i = 0; i < 300; i++) {
      validate(`not_a_real_event_${i}` as never, {})
    }

    expect(_getValidatorWarnCacheSizeForTests()).toBeLessThanOrEqual(256)
  })

  it('prunes expired warn rate-limit entries', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0)
    validate('not_a_real_event' as never, {})

    expect(_getValidatorWarnCacheSizeForTests()).toBe(1)

    vi.spyOn(Date, 'now').mockReturnValue(60_000)
    validate('another_fake_event' as never, {})

    expect(_getValidatorWarnCacheSizeForTests()).toBe(1)
  })
})
