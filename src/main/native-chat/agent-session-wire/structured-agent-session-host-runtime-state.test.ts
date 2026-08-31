import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'

const NOW = 1_800_000_000_000

function reservedRecord(): AgentSessionRecord {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: 'session-probe',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' },
    lease: {
      sessionId: 'session-probe',
      runtimeKind: 'native',
      runtimeFence: 3,
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: 'spawn-probe',
      leaseDeadlineAt: NOW + 30_000,
      lastRenewedAt: NOW,
      handoffOperationId: 'op-1',
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'reserved',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: NOW,
    updatedAt: NOW
  }
}

function runtimeState(
  record: AgentSessionRecord | null,
  probeOwner: NonNullable<StructuredAgentSessionHostDeps['probeOwner']>
) {
  const deps = {
    store: { getRecord: () => record } as unknown as AgentSessionRecordStore,
    adapter: {},
    journalRoot: '/tmp',
    claimKeyId: 'key-1',
    probeOwner
  } as StructuredAgentSessionHostDeps
  return new StructuredAgentSessionHostRuntimeState(deps)
}

describe('host runtime-state owner probe', () => {
  it('routes an ownerless reservation through the strict probe instead of fabricating proof', async () => {
    // Fabricating `reservation-unused` here skipped the processless-proof rule the runtime
    // probe enforces — the exact answer that mints a second writer on one provider session.
    const probeOwner = vi.fn(async () => ({
      outcome: 'indeterminate' as const,
      reason: 'reservation named no process'
    }))
    const state = runtimeState(reservedRecord(), probeOwner)

    await expect(state.probeOwner('session-probe')).resolves.toEqual({
      outcome: 'indeterminate',
      reason: 'reservation named no process'
    })
    expect(probeOwner).toHaveBeenCalledTimes(1)
  })

  it('skips the probe for a released ownerless record acquisition never consults it for', async () => {
    const released = reservedRecord()
    released.lease.claimStatus = 'released'
    released.lease.handoffStage = null
    released.lease.reservedSpawnToken = null
    const probeOwner = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'x' }))
    const state = runtimeState(released, probeOwner)

    await expect(state.probeOwner('session-probe')).resolves.toEqual({
      outcome: 'reservation-unused'
    })
    expect(probeOwner).not.toHaveBeenCalled()
  })

  it('treats a session with no record at all as an unused reservation', async () => {
    const probeOwner = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'x' }))
    const state = runtimeState(null, probeOwner)

    await expect(state.probeOwner('session-probe')).resolves.toEqual({
      outcome: 'reservation-unused'
    })
    expect(probeOwner).not.toHaveBeenCalled()
  })
})
