import { describe, it, expect } from 'vitest'
import { isTransientError } from './ssh-connection-utils'
import {
  isDefiniteSystemSshHostFailure,
  isTransientReconnectError
} from './ssh-reconnect-error-classification'

describe('isTransientReconnectError', () => {
  it('treats the system SSH connect timeout as recoverable', () => {
    const err = new Error('System SSH connection timed out')
    // Guards the split: widening isTransientError would spend 5 connect() attempts on this.
    expect(isTransientError(err)).toBe(false)
    expect(isTransientReconnectError(err)).toBe(true)
  })

  it.each([
    'System SSH probe failed (exit 255).',
    'System SSH probe failed (exit 255). stderr: ssh: connect to host box port 22: Connection refused',
    'System SSH probe failed (exit 255). stderr: ssh: connect to host box port 22: No route to host',
    'System SSH probe failed (exit 255). stderr: ssh: connect to host box port 22: Network is unreachable',
    'System SSH probe failed (exit 255). stderr: kex_exchange_identification: read: Connection reset by peer',
    'System SSH probe failed (exit 255). stderr: ssh: Could not resolve hostname box: Name or service not known',
    'System SSH probe failed (exit 255). stderr: ssh_exchange_identification: read: Connection reset by peer',
    'System SSH probe failed (exit 255). stderr: ssh_exchange_identification: Connection closed by remote host',
    'System SSH probe failed (exit 255). stderr: Connection closed by remote host',
    'System SSH probe failed (exit 255). stderr: Lost connection',
    'System SSH probe failed (exit 255). stderr: Remote end closed connection'
  ])('treats OpenSSH network prose as recoverable: %s', (message) => {
    expect(isTransientReconnectError(new Error(message))).toBe(true)
  })

  it('keeps the bare probe failure narrow to the reconnect classifier', () => {
    const err = new Error('System SSH probe failed (exit 255).')
    expect(isTransientError(err)).toBe(false)
    expect(isTransientReconnectError(err)).toBe(true)
  })

  // A server-side rejection prints the same verb without "remote"; retrying it forever would hide a
  // real misconfiguration behind the ladder.
  it('keeps a bare "Connection closed by <host> port <n>" permanent', () => {
    expect(
      isTransientReconnectError(
        new Error(
          'System SSH probe failed (exit 255). stderr: Connection closed by 10.0.0.4 port 22'
        )
      )
    ).toBe(false)
  })

  it('keeps credential failures permanent', () => {
    expect(
      isTransientReconnectError(new Error('All configured authentication methods failed'))
    ).toBe(false)
    expect(
      isTransientReconnectError(
        new Error('System SSH probe failed (exit 255). stderr: Permission denied (publickey).')
      )
    ).toBe(false)
    expect(
      isTransientReconnectError(
        new Error('Encrypted private OpenSSH key detected, but no passphrase given')
      )
    ).toBe(false)
  })

  it.each([
    'ssh: connect to host box port 22: Connection refused',
    'ssh: connect to host box port 22: Connection reset by peer',
    'ssh: connect to host box port 22: Connection timed out',
    'ssh: connect to host box port 22: No route to host',
    'ssh: Could not resolve hostname box: Name or service not known'
  ])('recognizes definite host failures for the ControlMaster retry gate: %s', (message) => {
    expect(isDefiniteSystemSshHostFailure(new Error(message))).toBe(true)
  })

  it.each([
    'System SSH connection timed out',
    'Connection refused',
    'Connection reset by peer',
    'mux client failed: master is unresponsive'
  ])('keeps potentially mux-shaped failures eligible for direct retry: %s', (message) => {
    expect(isDefiniteSystemSshHostFailure(new Error(message))).toBe(false)
  })

  it('still covers the errno codes isTransientError already matched', () => {
    const err = new Error('refused') as NodeJS.ErrnoException
    err.code = 'ECONNREFUSED'
    expect(isTransientReconnectError(err)).toBe(true)
  })

  it('keeps unrelated failures permanent', () => {
    expect(isTransientReconnectError(new Error('something went wrong'))).toBe(false)
  })
})
