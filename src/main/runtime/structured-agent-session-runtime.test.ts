import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-runtime'

const HOST_ID = 'local'

function record(
  ownerProcess: AgentSessionProcessIdentity | null,
  processlessAt?: number | null
): AgentSessionRecord {
  return { sessionId: 'session-1', lease: { ownerProcess, processlessAt } } as AgentSessionRecord
}

const OWNER: AgentSessionProcessIdentity = {
  hostId: HOST_ID,
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'token-1'
}

describe('structured agent-session owner probe', () => {
  it('probes an owner this host spawned', async () => {
    const probe = vi.fn(async () => ({ outcome: 'pid-absent' }) as const)
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe)(record(OWNER))

    expect(probe).toHaveBeenCalledWith({ identity: OWNER })
    expect(result).toEqual({ outcome: 'pid-absent' })
  })

  it('refuses to probe an owner on another host, whose pid means nothing here', async () => {
    const probe = vi.fn(async () => ({ outcome: 'pid-absent' }) as const)
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      probe
    )(record({ ...OWNER, hostId: 'ssh:build-box' }))

    expect(probe).not.toHaveBeenCalled()
    expect(result.outcome).toBe('indeterminate')
  })

  it('leaves a reservation that never named a process for manual recovery', async () => {
    const probe = vi.fn(async () => ({ outcome: 'pid-absent' }) as const)
    const result = await createStructuredAgentSessionOwnerProbe(HOST_ID, probe)(record(null))

    expect(probe).not.toHaveBeenCalled()
    // Evicting here would need proof nothing spawned under the token; guessing
    // would put a second writer on a live Codex thread.
    expect(result.outcome).toBe('indeterminate')
  })

  it('releases only a reservation carrying durable pre-spawn proof', async () => {
    const probe = vi.fn(async () => ({ outcome: 'pid-absent' }) as const)
    const result = await createStructuredAgentSessionOwnerProbe(
      HOST_ID,
      probe
    )(record(null, 1_800_000_000_000))

    expect(probe).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'reservation-unused' })
  })
})
