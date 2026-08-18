import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAgentStatusOscNonceRegistry,
  forgetAgentStatusOscNonceForPty,
  getAgentStatusOscNonceForPty,
  recordAgentStatusOscNonceForPty
} from './agent-status-osc-nonce-registry'

const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('agent status OSC nonce registry', () => {
  beforeEach(() => {
    clearAgentStatusOscNonceRegistry()
  })

  it('records a spawn-env nonce under its PTY', () => {
    recordAgentStatusOscNonceForPty('pty-1', NONCE)

    expect(getAgentStatusOscNonceForPty('pty-1')).toBe(NONCE)
    expect(getAgentStatusOscNonceForPty('pty-2')).toBeNull()
  })

  it('reports an unstamped PTY as null rather than a falsy string', () => {
    expect(getAgentStatusOscNonceForPty('never-spawned')).toBeNull()
  })

  it.each([undefined, null, '', 42, {}, 'x'.repeat(129)])(
    'ignores the malformed env value %p',
    (value) => {
      recordAgentStatusOscNonceForPty('pty-1', value)

      expect(getAgentStatusOscNonceForPty('pty-1')).toBeNull()
    }
  )

  it('keeps the original nonce when a reattach arrives with no env', () => {
    // Why: a reattach whose env we cannot see must not silently downgrade a
    // pane whose live agent is still presenting the original nonce.
    recordAgentStatusOscNonceForPty('pty-1', NONCE)

    expect(recordAgentStatusOscNonceForPty('pty-1', undefined)).toBe(NONCE)
    expect(getAgentStatusOscNonceForPty('pty-1')).toBe(NONCE)
  })

  it('drops the nonce with the PTY so a reused id cannot inherit it', () => {
    recordAgentStatusOscNonceForPty('pty-1', NONCE)

    forgetAgentStatusOscNonceForPty('pty-1')

    expect(getAgentStatusOscNonceForPty('pty-1')).toBeNull()
  })
})
