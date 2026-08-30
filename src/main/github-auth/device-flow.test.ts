import { describe, expect, it } from 'vitest'
import { pollResultFromTokenPayload } from './device-flow'

describe('pollResultFromTokenPayload', () => {
  it('maps an access token to authorized', () => {
    expect(pollResultFromTokenPayload({ access_token: 'tok', token_type: 'bearer' })).toEqual({
      status: 'authorized',
      token: 'tok'
    })
  })

  it('keeps authorization_pending as pending', () => {
    expect(pollResultFromTokenPayload({ error: 'authorization_pending' })).toEqual({
      status: 'pending'
    })
  })

  it('carries the requested backoff interval on slow_down', () => {
    expect(pollResultFromTokenPayload({ error: 'slow_down', interval: 10 })).toEqual({
      status: 'pending',
      pollIntervalSeconds: 10
    })
  })

  it('maps terminal RFC 8628 errors to user-readable states', () => {
    expect(pollResultFromTokenPayload({ error: 'access_denied' })).toMatchObject({
      status: 'error'
    })
    expect(pollResultFromTokenPayload({ error: 'expired_token' })).toMatchObject({
      status: 'error'
    })
    expect(pollResultFromTokenPayload({ error: 'incorrect_device_code' })).toMatchObject({
      status: 'error'
    })
  })

  it('falls back to error_description for unknown errors', () => {
    expect(
      pollResultFromTokenPayload({ error: 'server_error', error_description: 'boom' })
    ).toEqual({ status: 'error', error: 'boom' })
  })
})
