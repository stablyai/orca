import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import { refreshAfterCredentialChange } from './credential-change-rate-limit-refresh'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('refreshAfterCredentialChange', () => {
  it('does nothing without a rate-limit service', () => {
    const invalidate = vi.fn()
    refreshAfterCredentialChange(null, invalidate, '[test] refresh failed:')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('invalidates before refreshing', () => {
    const order: string[] = []
    const service = {
      refresh: vi.fn(async () => {
        order.push('refresh')
        return createEmptyRateLimitState()
      })
    }
    refreshAfterCredentialChange(service, () => order.push('invalidate'), '[test] refresh failed:')
    expect(order).toEqual(['invalidate', 'refresh'])
  })

  it('logs a failed background refresh with the caller message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('network down')
    const service = {
      refresh: vi.fn(async () => {
        throw failure
      })
    }

    refreshAfterCredentialChange(service, () => {}, '[test] refresh failed:')
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[test] refresh failed:', failure))
  })
})
