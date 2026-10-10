import { describe, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import {
  assessOrcadMigrationTerminals,
  confirmOrcadMigrationTerminalsUnderFence,
  retireProvenExitedLeases,
  type ListRelayPtyIds
} from './orcad-migration-terminal-gate'

function store(leases: Pick<SshRemotePtyLease, 'ptyId' | 'state'>[]) {
  const full = leases.map((lease) => ({ ...lease, targetId: 'ssh-1', createdAt: 1, updatedAt: 1 }))
  return { getSshRemotePtyLeases: () => full }
}

function relay(current: string[] | null, previous: string[] | null): ListRelayPtyIds {
  const list: ListRelayPtyIds = async () => current
  list.previous = async () => previous
  return list
}

// Every relay on the account, whichever desktop launched it, holds no work.
const hostIdle = async () => ({ verdict: 'exited' as const, count: 0 })

describe('migration terminal gate', () => {
  it('proves exit from terminated leases and an empty relay', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'a', state: 'terminated' }]),
        'ssh-1',
        relay([], []),
        hostIdle
      )
    ).resolves.toEqual({ verdict: 'exited', provenPtyIds: ['a'] })
  })

  // Finding 3: with nothing leased here, a missing inventory must not read as nothing running.
  it.each([
    ['this relay did not answer', relay(null, [])],
    ['the earlier relays could not be asked', relay([], null)],
    ['a Windows earlier relay could not be bridged', relay([], null)]
  ])('is unverifiable with no leases when %s', async (_label, list) => {
    await expect(assessOrcadMigrationTerminals(store([]), 'ssh-1', list)).resolves.toMatchObject({
      verdict: 'unverifiable'
    })
  })

  it('needs a host census, not silence, when no relay session can be asked', async () => {
    await expect(assessOrcadMigrationTerminals(store([]), 'ssh-1', null)).resolves.toMatchObject({
      verdict: 'unverifiable',
      reason: "no census of every relay on this host's account was taken"
    })
    await expect(
      assessOrcadMigrationTerminals(store([]), 'ssh-1', null, async () => ({
        verdict: 'exited',
        count: 0
      }))
    ).resolves.toEqual({ verdict: 'exited', provenPtyIds: [] })
    for (const verdict of ['live', 'unverifiable'] as const) {
      await expect(
        assessOrcadMigrationTerminals(store([]), 'ssh-1', null, async () => ({ verdict, count: 1 }))
      ).resolves.toMatchObject({ verdict })
    }
    await expect(
      assessOrcadMigrationTerminals(store([]), 'ssh-1', null, async () => {
        throw new Error('connect refused')
      })
    ).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('lets an idle host census prove leases an older build left, with no relay session', async () => {
    const leftover = store([
      { ptyId: 'pty-attached', state: 'attached' },
      { ptyId: 'pty-detached', state: 'detached' },
      { ptyId: 'pty-expired', state: 'expired' }
    ])
    await expect(assessOrcadMigrationTerminals(leftover, 'ssh-1', null, hostIdle)).resolves.toEqual(
      {
        verdict: 'exited',
        provenPtyIds: ['pty-attached', 'pty-detached', 'pty-expired']
      }
    )
    await expect(
      assessOrcadMigrationTerminals(leftover, 'ssh-1', null, async () => ({
        verdict: 'live',
        count: 2
      }))
    ).resolves.toMatchObject({ verdict: 'live', hostTerminals: 2 })
    // Without a census the leases still block: silence is never exit.
    await expect(assessOrcadMigrationTerminals(leftover, 'ssh-1', null)).resolves.toMatchObject({
      verdict: 'live'
    })
  })

  it('blocks an attached lease as live', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'a', state: 'attached' }]),
        'ssh-1',
        async () => []
      )
    ).resolves.toMatchObject({ verdict: 'live', ptyIds: ['a'] })
  })

  // B4 after an app update: a shell a respawn superseded on its tab still runs on the previous
  // relay, with no live lease here; only the leased shells were counted before.
  it('counts a shell an earlier relay still runs that no lease here knows', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([
          { ptyId: 'pty2:8ea088dc:1', state: 'terminated' },
          { ptyId: 'pty2:8ea088dc:2', state: 'attached' }
        ]),
        'ssh-1',
        relay(['pty2:8ea088dc:2'], ['pty2:8ea088dc:2', 'pty2:8ea088dc:cli'])
      )
    ).resolves.toMatchObject({
      verdict: 'live',
      ptyIds: ['pty2:8ea088dc:2', 'pty2:8ea088dc:cli']
    })
    await expect(
      assessOrcadMigrationTerminals(store([]), 'ssh-1', relay([], ['pty2:8ea088dc:cli']))
    ).resolves.toMatchObject({ verdict: 'live', ptyIds: ['pty2:8ea088dc:cli'] })
  })

  it('counts every shell the relay lists alongside the attached leases', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'a', state: 'attached' }]),
        'ssh-1',
        async () => ['a', 'cli-shell']
      )
    ).resolves.toMatchObject({ verdict: 'live', ptyIds: ['a', 'cli-shell'] })
  })

  it('proves a detached terminal exited once this relay and earlier relays both answer without it', async () => {
    const leases = store([{ ptyId: 'a', state: 'detached' }])
    const proof = await assessOrcadMigrationTerminals(leases, 'ssh-1', relay([], []), hostIdle)
    expect(proof).toEqual({ verdict: 'exited', provenPtyIds: ['a'] })

    // Only the move acting on the proof retires the lease; asking alone changes nothing.
    const markSshRemotePtyLease = vi.fn()
    retireProvenExitedLeases({ ...leases, markSshRemotePtyLease }, 'ssh-1', proof)
    expect(markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'a', 'terminated')
  })

  it('blocks a detached terminal an earlier relay still runs as live', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'a', state: 'detached' }]),
        'ssh-1',
        relay([], ['a'])
      )
    ).resolves.toMatchObject({ verdict: 'live', ptyIds: ['a'] })
  })

  it.each([
    ['this relay did not answer', relay(null, [])],
    ['earlier relays could not be asked (Windows, no census, unreachable)', relay([], null)],
    ['no earlier-relay lister', async () => []]
  ])('keeps a detached or expired lease unverifiable when %s', async (_label, list) => {
    for (const state of ['detached', 'expired'] as const) {
      await expect(
        assessOrcadMigrationTerminals(store([{ ptyId: 'a', state }]), 'ssh-1', list)
      ).resolves.toMatchObject({ verdict: 'unverifiable', ptyIds: ['a'] })
    }
  })

  it('blocks an expired terminal an earlier relay still runs as live', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'old', state: 'expired' }]),
        'ssh-1',
        relay([], ['old'])
      )
    ).resolves.toMatchObject({ verdict: 'live', ptyIds: ['old'] })
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

  it('accepts an expired lease once every relay answers that nothing runs', async () => {
    await expect(
      assessOrcadMigrationTerminals(
        store([{ ptyId: 'old', state: 'expired' }]),
        'ssh-1',
        relay([], []),
        hostIdle
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
