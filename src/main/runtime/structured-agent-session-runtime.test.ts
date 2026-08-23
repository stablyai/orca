import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionClaimStatus,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-runtime'

const HOST_ID = 'local'

function record(
  ownerProcess: AgentSessionProcessIdentity | null,
  lease: {
    processlessAt?: number | null
    reservedSpawnToken?: string | null
    claimStatus?: AgentSessionClaimStatus
    runtimeFence?: number
  } = {}
): AgentSessionRecord {
  return {
    sessionId: 'session-1',
    providerHandleChain: [],
    lease: {
      ownerProcess,
      reservedSpawnToken: null,
      claimStatus: 'released',
      runtimeFence: 3,
      ...lease
    }
  } as unknown as AgentSessionRecord
}

const OWNER: AgentSessionProcessIdentity = {
  hostId: HOST_ID,
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'token-1'
}

const deadProbe = () => vi.fn(async () => ({ outcome: 'pid-absent' }) as const)

describe('structured agent-session owner probe', () => {
  it('probes an owner this host spawned', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe)(record(OWNER))

    expect(probe).toHaveBeenCalledWith({
      identity: OWNER,
      deps: { readEchoedSpawnToken: expect.any(Function) }
    })
    expect(result).toEqual({ outcome: 'pid-absent' })
  })

  it('refuses to probe an owner on another host, whose pid means nothing here', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      probe
    )(record({ ...OWNER, hostId: 'ssh:build-box' }))

    expect(probe).not.toHaveBeenCalled()
    expect(result.outcome).toBe('indeterminate')
  })

  it('leaves a reservation whose spawn token is still live on this host latched', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe, async () => [9001])(
      record(null, { claimStatus: 'reserved', reservedSpawnToken: 'token-1' })
    )

    // Evicting here would put a second writer on a live Codex thread.
    expect(result.outcome).toBe('indeterminate')
  })

  it('leaves a reservation latched on a host that cannot enumerate spawn tokens', async () => {
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      deadProbe(),
      async () => null
    )(record(null, { claimStatus: 'reserved', reservedSpawnToken: 'token-1' }))

    expect(result.outcome).toBe('indeterminate')
  })

  it('frees a reservation once the host proves no process carries its token', async () => {
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      deadProbe(),
      async () => []
    )(record(null, { claimStatus: 'reserved', reservedSpawnToken: 'token-1' }))

    expect(result).toEqual({ outcome: 'reservation-unused' })
  })

  it('frees a lease that names neither an owner nor a spawn token', async () => {
    const probe = deadProbe()
    const scan = vi.fn(async () => [] as number[])
    // Nothing was ever minted that a child could be carrying, so no scan is even needed;
    // answering `indeterminate` here is what latches every released record into recovery.
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe, scan)(record(null))

    expect(probe).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'reservation-unused' })
  })

  it('still refuses a reservation that recorded no token to scan for', async () => {
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      deadProbe(),
      async () => []
    )(record(null, { claimStatus: 'reserved' }))

    expect(result.outcome).toBe('indeterminate')
  })

  it('releases only a reservation carrying durable pre-spawn proof', async () => {
    const probe = deadProbe()
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      probe
    )(record(null, { processlessAt: 1_800_000_000_000, claimStatus: 'reserved' }))

    expect(probe).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'reservation-unused' })
  })
})
