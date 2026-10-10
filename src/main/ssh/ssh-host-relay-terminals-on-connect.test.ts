import { describe, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import type { HostRelayEndpointCensus } from './ssh-host-relay-endpoint-census'
import type { ListRelayPtyIds } from './orcad-migration-terminal-gate'
import { relayTerminalsOnConnect } from './ssh-host-relay-terminals-on-connect'

function store(leases: Pick<SshRemotePtyLease, 'ptyId' | 'state'>[] = []) {
  const full = leases.map((lease) => ({ ...lease, targetId: 'ssh-1', createdAt: 1, updatedAt: 1 }))
  return { getSshRemotePtyLeases: () => full }
}

const decide = (
  census: HostRelayEndpointCensus | Error,
  options: { leases?: Parameters<typeof store>[0]; lister?: ListRelayPtyIds } = {}
) => {
  const censusHost = vi.fn(async () => {
    if (census instanceof Error) {
      throw census
    }
    return census
  })
  return {
    censusHost,
    verdict: relayTerminalsOnConnect({
      store: store(options.leases),
      targetId: 'ssh-1',
      listRelayPtyIds: options.lister ?? null,
      censusHost
    })
  }
}

describe('the connect-time relay terminal verdict', () => {
  it.each([
    ['no relay endpoints at all', { verdict: 'none', count: 0 }],
    ['endpoints with no live work', { verdict: 'idle', count: 0 }]
  ] as const)('converts with %s', async (_label, census) => {
    await expect(decide(census).verdict).resolves.toEqual({ verdict: 'exited', count: 0 })
  })

  it('stays on the relay while any endpoint, even another desktop’s, runs live work', async () => {
    // Only the host-wide census counted them, so they belong to another desktop or session.
    await expect(decide({ verdict: 'live', count: 2 }).verdict).resolves.toEqual({
      verdict: 'live',
      count: 2,
      elsewhere: true
    })
  })

  it.each([
    ['incomplete', { verdict: 'unverifiable', count: 1 } as const],
    ['could not list the endpoints', { verdict: 'unenumerable', count: 0 } as const],
    ['failed', new Error('connect refused')]
  ])('refuses as unverifiable when the census %s', async (_label, census) => {
    await expect(decide(census).verdict).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  // With no relay session, a lease an older build left proves nothing; the host census decides.
  it('lets an idle host census prove a lease an older build left', async () => {
    const { censusHost, verdict } = decide(
      { verdict: 'none', count: 0 },
      { leases: [{ ptyId: 'a', state: 'attached' }] }
    )
    await expect(verdict).resolves.toEqual({ verdict: 'exited', count: 0 })
    expect(censusHost).toHaveBeenCalledTimes(1)
  })

  // Astra pass 4 §2: this target's empty lists cannot see another desktop's relay on the account.
  it('asks the account-wide census even when the connected relay answered empty', async () => {
    const { censusHost, verdict } = decide(
      { verdict: 'live', count: 1 },
      { lister: Object.assign(async () => [], { previous: async () => [] }) }
    )
    await expect(verdict).resolves.toEqual({ verdict: 'live', count: 1, elsewhere: true })
    expect(censusHost).toHaveBeenCalledTimes(1)
  })

  it('attributes terminals this target lists to this desktop', async () => {
    const listed = decide(
      { verdict: 'live', count: 3 },
      { lister: Object.assign(async () => ['pty-1'], { previous: async () => [] }) }
    )
    await expect(listed.verdict).resolves.toEqual({ verdict: 'live', count: 1 })
  })

  // A session whose relays could not answer proves nothing, and no lease here changes that.
  it.each([
    ['this relay', Object.assign(async () => null, { previous: async () => [] })],
    ['an earlier relay', Object.assign(async () => [], { previous: async () => null })]
  ])('is unverifiable with no leases when %s could not answer', async (_label, lister) => {
    const { censusHost, verdict } = decide({ verdict: 'none', count: 0 }, { lister })
    await expect(verdict).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(censusHost).not.toHaveBeenCalled()
  })
})
