import { describe, expect, it } from 'vitest'
import {
  createSshDisposalError,
  isSshRequestOutcomeUnverifiable,
  SSH_MUX_REQUEST_TIMEOUT_CODE
} from './ssh-channel-multiplexer'

// Use live/unverifiable/exited vocabulary: lost contact never proves absence (docs/reference/ssh-execution-boundary.md).
describe('SSH request outcome verdict', () => {
  it('treats a response deadline as unverifiable', () => {
    const timedOut = Object.assign(new Error('Request "x" timed out after 30000ms'), {
      code: SSH_MUX_REQUEST_TIMEOUT_CODE
    })
    expect(isSshRequestOutcomeUnverifiable(timedOut)).toBe(true)
  })

  it('treats a link declared lost as unverifiable, not as absence', () => {
    // Wedged links now report CONNECTION_LOST instead of request timeout; both must retain possibly-running host outcome.
    expect(isSshRequestOutcomeUnverifiable(createSshDisposalError('connection_lost'))).toBe(true)
  })

  it('does not claim unverifiable for a deliberate shutdown', () => {
    expect(isSshRequestOutcomeUnverifiable(createSshDisposalError('shutdown'))).toBe(false)
  })

  it('does not claim unverifiable for an ordinary failure', () => {
    expect(isSshRequestOutcomeUnverifiable(new Error('boom'))).toBe(false)
    expect(isSshRequestOutcomeUnverifiable(undefined)).toBe(false)
  })
})
