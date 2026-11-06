import { describe, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import {
  assessOrcadMigrationTerminals,
  confirmOrcadMigrationTerminalsUnderFence,
  retireProvenExitedLeases
} from './orcad-migration-terminal-gate'

type LeaseRow = Pick<SshRemotePtyLease, 'ptyId' | 'state'>

function store(leases: LeaseRow[]) {
  const full = leases.map((lease) => ({ ...lease, targetId: 'ssh-1', createdAt: 1, updatedAt: 1 }))
  return { getSshRemotePtyLeases: () => full }
}

const MIXED: LeaseRow[] = [
  { ptyId: 'att', state: 'attached' },
  { ptyId: 'det', state: 'detached' },
  { ptyId: 'exp', state: 'expired' },
  { ptyId: 'ter', state: 'terminated' }
]

describe('terminal gate characterization: census-only verdicts', () => {
  it('a census that throws is bridged as unverifiable, never exited', async () => {
    await expect(
      assessOrcadMigrationTerminals(store(MIXED), 'ssh-1', async () => {
        throw new Error('connect refused')
      })
    ).resolves.toEqual({
      verdict: 'bridged',
      relayVerdict: 'unverifiable',
      bridgedPtyIds: ['att', 'det', 'exp'],
      hostTerminals: 0
    })
  })
})

describe('acting on a terminal proof', () => {
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

// COMPAT(legacy-relay-bridge): the leases a bridged conversion recorded never read as new terminals.
describe('a bridged conversion under its fence', () => {
  const bridged = {
    verdict: 'bridged' as const,
    relayVerdict: 'live' as const,
    bridgedPtyIds: ['att', 'det'],
    hostTerminals: 1
  }

  it('still refuses a lease that appeared after the proof', () => {
    const leases = store([
      { ptyId: 'att', state: 'attached' },
      { ptyId: 'new', state: 'attached' }
    ])
    expect(confirmOrcadMigrationTerminalsUnderFence(leases, 'ssh-1', bridged)).toMatchObject({
      verdict: 'live',
      ptyIds: ['new']
    })
  })

  it('retires nothing it bridged', () => {
    const leases = store([{ ptyId: 'att', state: 'attached' }])
    const markSshRemotePtyLease = vi.fn()
    retireProvenExitedLeases({ ...leases, markSshRemotePtyLease }, 'ssh-1', bridged)
    expect(markSshRemotePtyLease).not.toHaveBeenCalled()
  })
})
