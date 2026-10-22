import { describe, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { HostRelayEndpointCensus } from './ssh-host-relay-endpoint-census'
import { relayTerminalsOnConnect } from './ssh-host-relay-terminals-on-connect'

function store(leases: Pick<SshRemotePtyLease, 'ptyId' | 'state'>[] = []) {
  const full = leases.map((lease) => ({ ...lease, targetId: 'ssh-1', createdAt: 1, updatedAt: 1 }))
  return { getSshRemotePtyLeases: () => full }
}

const decide = (
  census: HostRelayEndpointCensus | Error,
  options: { leases?: Parameters<typeof store>[0] } = {}
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

  it('reads live work, even another desktop’s, as live and leaves it to the bridge', async () => {
    // COMPAT(legacy-relay-bridge): the host converts anyway; nothing here stops a relay.
    await expect(decide({ verdict: 'live', count: 2 }).verdict).resolves.toEqual({
      verdict: 'live',
      count: 2,
      bridged: true
    })
  })

  it.each([
    ['incomplete', { verdict: 'unverifiable', count: 1 } as const],
    ['could not list the endpoints', { verdict: 'unenumerable', count: 0 } as const],
    ['failed', new Error('connect refused')]
  ])('reads unverifiable, never exited, when the census %s', async (_label, census) => {
    await expect(decide(census).verdict).resolves.toMatchObject({
      verdict: 'unverifiable',
      bridged: true
    })
  })

  // A lease an older build left proves nothing; the host census decides.
  it('lets an idle host census prove a lease an older build left', async () => {
    const { censusHost, verdict } = decide(
      { verdict: 'none', count: 0 },
      { leases: [{ ptyId: 'a', state: 'attached' }] }
    )
    await expect(verdict).resolves.toEqual({ verdict: 'exited', count: 0 })
    expect(censusHost).toHaveBeenCalledTimes(1)
  })
})
