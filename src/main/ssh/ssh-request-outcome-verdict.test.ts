import { describe, expect, it } from 'vitest'
import {
  createSshDisposalError,
  isSshRequestOutcomeUnverifiable,
  SSH_MUX_REQUEST_TIMEOUT_CODE
} from './ssh-channel-multiplexer'

// docs/reference/ssh-execution-boundary.md: the vocabulary is live / unverifiable / exited, and
// loss of contact is never evidence of absence. Three call sites phrase this verdict to a user, so
// collapsing "unverifiable" into "could not be reached" is a user-visible lie.
describe('SSH request outcome verdict', () => {
  it('treats a response deadline as unverifiable', () => {
    const timedOut = Object.assign(new Error('Request "x" timed out after 30000ms'), {
      code: SSH_MUX_REQUEST_TIMEOUT_CODE
    })
    expect(isSshRequestOutcomeUnverifiable(timedOut)).toBe(true)
  })

  it('treats a link declared lost as unverifiable, not as absence', () => {
    // The regression this exists for: declaring a wedged link lost at TIMEOUT_MS made those
    // requests surface CONNECTION_LOST where they used to surface a timeout, silently downgrading
    // the honest "may still be running on the remote host" to "could not be reached".
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
