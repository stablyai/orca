import { describe, expect, it } from 'vitest'
import { describeSshConnectFailure } from './ssh-connect-failure-next-step'
import { HostKeyVerificationError } from './ssh-host-key-decision'

const withCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code })

describe('describeSshConnectFailure', () => {
  it.each([
    [
      withCode('connect ECONNREFUSED 10.0.0.1:22', 'ECONNREFUSED'),
      /^Nothing accepted the SSH connection/
    ],
    [
      new Error('All configured authentication methods failed'),
      /^The host didn’t accept any sign-in/
    ],
    [
      new Error('Timed out while waiting for SSH authentication'),
      /^The connection didn’t finish in time/
    ],
    [
      withCode('getaddrinfo ENOTFOUND box.invalid', 'ENOTFOUND'),
      /^The host name couldn’t be looked up/
    ],
    [withCode('connect EHOSTUNREACH 10.0.0.9:22', 'EHOSTUNREACH'), /^There’s no network route/],
    [
      new Error('System SSH probe failed (exit 255). stderr: Host key verification failed.'),
      /^SSH couldn’t confirm this host’s identity/
    ]
  ])('leads %s with what to do, keeping SSH’s words', (error, nextStep) => {
    const text = describeSshConnectFailure(error)
    expect(text).toMatch(nextStep)
    expect(text).toContain(`(${error.message})`)
  })

  it('names a key that would not unlock, not the host, for a passphrase failure', () => {
    expect(describeSshConnectFailure(new Error('Cannot parse privateKey: bad decrypt'))).toMatch(
      /^Orca couldn’t unlock the SSH key/
    )
  })

  it('leaves a cancelled sign-in and Orca’s own host-key refusals as they are', () => {
    const cancelled = Object.assign(
      new Error('Keyboard-interactive authentication cancelled for Box'),
      { level: 'client-authentication' }
    )
    expect(describeSshConnectFailure(cancelled)).toBe(cancelled.message)
    const refused = new HostKeyVerificationError(
      'Host key verification failed for box. Remove its entry from the Orca host key store.',
      'mismatch'
    )
    expect(describeSshConnectFailure(refused)).toBe(refused.message)
  })

  it('leaves a failure it cannot name as SSH said it', () => {
    expect(describeSshConnectFailure(new Error('Connection lost before handshake'))).toBe(
      'Connection lost before handshake'
    )
  })
})
