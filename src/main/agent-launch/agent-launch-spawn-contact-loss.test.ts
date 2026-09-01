import { describe, expect, it } from 'vitest'
import { isSpawnContactLossError } from './agent-launch-spawn-contact-loss'

describe('isSpawnContactLossError', () => {
  it('recognizes the SSH transport rejections that can interrupt a dispatched spawn', () => {
    expect(
      isSpawnContactLossError(
        Object.assign(new Error('SSH connection lost, reconnecting...'), {
          code: 'CONNECTION_LOST'
        })
      )
    ).toBe(true)
    expect(
      isSpawnContactLossError(
        Object.assign(new Error('Multiplexer disposed'), { code: 'DISPOSED' })
      )
    ).toBe(true)
    expect(
      isSpawnContactLossError(
        Object.assign(new Error('Request "pty.spawn" timed out after 30000ms'), {
          code: 'SSH_MUX_REQUEST_TIMEOUT'
        })
      )
    ).toBe(true)
  })

  it('recognizes the established post-dispatch ambiguity marker', () => {
    expect(
      isSpawnContactLossError(
        Object.assign(new Error('execution_owner_unavailable'), {
          agentSessionOperationOutcome: 'unknown' as const
        })
      )
    ).toBe(true)
  })

  it('treats host-attested spawn failures as attested, not contact loss', () => {
    expect(isSpawnContactLossError(new Error('pty boom'))).toBe(false)
    expect(isSpawnContactLossError(new Error('client_disconnected'))).toBe(false)
    expect(isSpawnContactLossError(new Error('execution_owner_unavailable'))).toBe(false)
    expect(
      isSpawnContactLossError(Object.assign(new Error('other'), { code: 'SOMETHING_ELSE' }))
    ).toBe(false)
    expect(isSpawnContactLossError(null)).toBe(false)
    expect(isSpawnContactLossError('CONNECTION_LOST')).toBe(false)
  })
})
