import { describe, expect, it } from 'vitest'
import { normalizeSshRemotePtyLease } from './ssh-normalization'

const LEASE = {
  targetId: 'ssh-1',
  ptyId: 'pty-1',
  state: 'detached' as const,
  createdAt: 1,
  updatedAt: 1
}

describe('SSH relay process identity persistence', () => {
  it('preserves a bounded process identity', () => {
    expect(
      normalizeSshRemotePtyLease({ ...LEASE, relayProcessId: 'relay-process-1' })
    ).toMatchObject({ relayProcessId: 'relay-process-1' })
  })

  it.each(['', 'x'.repeat(129), 42])('drops malformed process identity %j', (relayProcessId) => {
    expect(normalizeSshRemotePtyLease({ ...LEASE, relayProcessId })).not.toHaveProperty(
      'relayProcessId'
    )
  })
})
