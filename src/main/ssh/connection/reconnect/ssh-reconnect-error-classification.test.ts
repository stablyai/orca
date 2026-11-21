import { describe, expect, it } from 'vitest'
import { isTransientReconnectError } from './ssh-reconnect-error-classification'

describe('isTransientReconnectError', () => {
  it('retries a system SSH probe that a ProxyCommand closed before the handshake', () => {
    const closedByProxy = new Error(
      'System SSH probe failed (exit 255). stderr: Connection closed by UNKNOWN port 65535'
    )
    const closedByRemoteSshd = new Error(
      'System SSH probe failed (exit 255). stderr: Connection closed by 203.0.113.8 port 22'
    )

    expect(isTransientReconnectError(closedByProxy)).toBe(true)
    expect(isTransientReconnectError(closedByRemoteSshd)).toBe(false)
  })
})
