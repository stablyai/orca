import { describe, it, expect } from 'vitest'
import {
  createCancelledConnectAttemptError,
  isCancelledConnectAttemptError
} from './ssh-connect-attempt-cancellation'
import { isAuthError } from './ssh-connection-utils'
import { isTransientReconnectError } from './ssh-reconnect-error-classification'

describe('createCancelledConnectAttemptError', () => {
  it('is recognisable by identity, not just by message text', () => {
    const error = createCancelledConnectAttemptError()
    expect(isCancelledConnectAttemptError(error)).toBe(true)
    // A cancelled attempt must never look like a permanent failure to the reconnect ladder.
    expect(isTransientReconnectError(error)).toBe(false)
    expect(isAuthError(error)).toBe(false)
  })

  it('does not classify unrelated errors as cancellations', () => {
    expect(isCancelledConnectAttemptError(new Error('connect ETIMEDOUT'))).toBe(false)
  })

  it('ignores a lookalike message from a producer that skipped the factory', () => {
    // Every real producer imports the factory, so message text alone must not qualify.
    expect(
      isCancelledConnectAttemptError(new Error(createCancelledConnectAttemptError().message))
    ).toBe(false)
  })
})
