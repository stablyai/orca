import { describe, expect, it } from 'vitest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import {
  assessOrcadMigrationTerminals,
  confirmOrcadMigrationTerminalsUnderFence
} from './orcad-migration-terminal-gate'

function store(leases: Pick<SshRemotePtyLease, 'ptyId' | 'state'>[]) {
  const full = leases.map((lease) => ({ ...lease, targetId: 'ssh-1', createdAt: 1, updatedAt: 1 }))
  return { getSshRemotePtyLeases: () => full }
}

describe('migration terminal gate', () => {
  it('proves exit from terminated leases and an empty relay', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'a', state: 'terminated' }]),
        'ssh-1',
        async () => []
      )
    ).resolves.toEqual({ verdict: 'exited', provenPtyIds: ['a'] })
  })

  it.each(['attached', 'detached'] as const)('blocks a %s lease as live', async (state) => {
    await expect(
      assessOrcadMigrationTerminals(store([{ ptyId: 'a', state }]), 'ssh-1', async () => [])
    ).resolves.toMatchObject({ verdict: 'live', ptyIds: ['a'] })
  })

  it('blocks terminals the relay still runs even with no lease for them', async () => {
    await expect(
      assessOrcadMigrationTerminals(store([]), 'ssh-1', async () => ['x'])
    ).resolves.toMatchObject({ verdict: 'live', ptyIds: ['x'] })
  })

  it.each([
    ['no relay to ask', null],
    ['a relay that did not answer', async () => null],
    [
      'a relay that failed',
      async () => {
        throw new Error('channel closed')
      }
    ]
  ])('reads an expired lease with %s as unverifiable, never as exited', async (_label, list) => {
    await expect(
      assessOrcadMigrationTerminals(store([{ ptyId: 'old', state: 'expired' }]), 'ssh-1', list)
    ).resolves.toMatchObject({ verdict: 'unverifiable', ptyIds: ['old'] })
  })

  it('accepts an expired lease once the relay answers that nothing runs', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'old', state: 'expired' }]),
        'ssh-1',
        async () => []
      )
    ).resolves.toEqual({ verdict: 'exited', provenPtyIds: ['old'] })
  })

  it('confirms under the fence only when no unproven terminal appeared', () => {
    const proof = { verdict: 'exited' as const, provenPtyIds: ['old'] }
    expect(
      confirmOrcadMigrationTerminalsUnderFence(
        store([{ ptyId: 'old', state: 'expired' }]),
        'ssh-1',
        proof
      )
    ).toBe(proof)
    expect(
      confirmOrcadMigrationTerminalsUnderFence(
        store([{ ptyId: 'new', state: 'expired' }]),
        'ssh-1',
        proof
      )
    ).toMatchObject({ verdict: 'unverifiable', ptyIds: ['new'] })
    expect(
      confirmOrcadMigrationTerminalsUnderFence(
        store([{ ptyId: 'old', state: 'attached' }]),
        'ssh-1',
        proof
      )
    ).toMatchObject({ verdict: 'live' })
    expect(
      confirmOrcadMigrationTerminalsUnderFence(
        store([{ ptyId: 'new', state: 'terminated' }]),
        'ssh-1',
        proof
      )
    ).toBe(proof)
  })
})
