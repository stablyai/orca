import { describe, expect, it } from 'vitest'
import { parseStagingPowerRequest } from './staging-workflow.js'

describe('parseStagingPowerRequest', () => {
  it('accepts the exact reviewed confirmations', () => {
    expect(parseStagingPowerRequest({ mode: 'status', confirmation: '' })).toEqual({
      mode: 'status', confirmation: ''
    })
    expect(parseStagingPowerRequest({ mode: 'wake', confirmation: 'WAKE_STAGING' }).mode).toBe('wake')
    expect(parseStagingPowerRequest({ mode: 'sleep', confirmation: 'SLEEP_STAGING' }).mode).toBe('sleep')
  })

  it('rejects missing, swapped, or additional fields', () => {
    expect(() => parseStagingPowerRequest({ mode: 'wake', confirmation: '' })).toThrow()
    expect(() => parseStagingPowerRequest({ mode: 'sleep', confirmation: 'WAKE_STAGING' })).toThrow()
    expect(() => parseStagingPowerRequest({ mode: 'production', confirmation: '' })).toThrow()
    expect(() => parseStagingPowerRequest({ mode: 'status', confirmation: '', project: 'other' })).toThrow()
  })
})
