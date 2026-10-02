import { describe, expect, it } from 'vitest'
import { agentSessionLeaseFixture } from '../../../shared/agent-session-record.test-fixture'
import type { StructuredAgentSessionEndedChild } from './structured-agent-session-host-types'
import type { AgentSessionFailedAcquisitionSettlement } from '../../runtime/agent-session-acquisition-failure-settlement'
import {
  structuredAgentSessionAcquisitionProbe,
  structuredAgentSessionOwnerProof
} from './structured-agent-session-owner-proof'

const LEASE = agentSessionLeaseFixture({
  runtimeFence: 4,
  ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: null, spawnToken: 'spawn-a' }
})

function ended(
  overrides: Partial<StructuredAgentSessionEndedChild> = {}
): StructuredAgentSessionEndedChild {
  return {
    generation: 'generation-1',
    fence: 4,
    rootGone: true,
    cause: 'exit',
    reason: 'provider exited',
    duringStartup: false,
    observedAt: 900,
    endedAt: { epoch: 'epoch-1', sequence: 1 },
    ...overrides
  }
}

function proofFor(
  session: Parameters<typeof structuredAgentSessionOwnerProof>[0]['session'],
  lease = LEASE,
  hostId = 'local'
) {
  return structuredAgentSessionOwnerProof({ lease, hostId, session, attemptInFlight: false })
}

describe('the owner proof a host holds in memory', () => {
  it("names the child it runs at the lease's fence", () => {
    const child = { generation: 'generation-1', fence: 4, phase: 'ready' } as const
    expect(proofFor({ child, lastEndedChild: undefined }).owner).toEqual({ kind: 'runs' })
  })

  it('names an exit it watched, with the provider reason an exit carries', () => {
    expect(proofFor({ child: null, lastEndedChild: ended() }).owner).toEqual({
      kind: 'watched-exit',
      observedAt: 900,
      reason: 'provider exited'
    })
    expect(
      proofFor({ child: null, lastEndedChild: ended({ cause: 'user-stop' }) }).owner
    ).toMatchObject({ kind: 'watched-exit', reason: null })
  })

  it.each([
    [
      'an end that did not prove the root gone',
      { child: null, lastEndedChild: ended({ rootGone: false }) }
    ],
    ['an end at an older fence', { child: null, lastEndedChild: ended({ fence: 3 }) }],
    ['no conversation in memory', undefined]
  ] as const)('proves nothing from %s', (_label, session) => {
    expect(proofFor(session).owner).toEqual({ kind: 'none' })
  })

  it('speaks for no owner on another host, whatever memory holds', () => {
    expect(proofFor({ child: null, lastEndedChild: ended() }, LEASE, 'ssh:devbox').owner).toEqual({
      kind: 'none'
    })
  })
})

describe('the proof a failed attempt of its own leaves when its settlement never landed', () => {
  const RESERVATION = agentSessionLeaseFixture({
    runtimeFence: 4,
    claimStatus: 'reserved',
    handoffStage: 'new-owner-proving',
    handoffOperationId: 'op-1',
    ownerProcess: null,
    reservedSpawnToken: 'spawn-a'
  })
  function settlement(
    overrides: Partial<AgentSessionFailedAcquisitionSettlement> = {}
  ): AgentSessionFailedAcquisitionSettlement {
    return {
      sessionId: RESERVATION.sessionId,
      fence: 4,
      spawnToken: 'spawn-a',
      callerKey: 'caller-1',
      operationId: 'op-1',
      outcome: { status: 'failed', code: 'agent_session_operation_invalid', message: 'failed' },
      exitProof: 'exit-proven',
      now: 900,
      ...overrides
    }
  }
  function proofWith(
    unsettledAcquisition: AgentSessionFailedAcquisitionSettlement,
    lease = RESERVATION,
    hostId = 'local'
  ) {
    return structuredAgentSessionOwnerProof({
      lease,
      hostId,
      session: undefined,
      attemptInFlight: false,
      unsettledAcquisition
    })
  }

  it('speaks for the reservation it made, which records no host, and frees it on acquisition', () => {
    const proof = proofWith(settlement())
    expect(proof.owner).toEqual({
      kind: 'failed-acquisition',
      spawnToken: 'spawn-a',
      operationId: 'op-1',
      exitProof: 'exit-proven',
      observedAt: 900
    })
    expect(structuredAgentSessionAcquisitionProbe(RESERVATION, proof)).toEqual({
      outcome: 'reservation-unused'
    })
  })

  it("speaks for a recorded owner only when it is that attempt's own, on this host", () => {
    const spawned = {
      ...RESERVATION,
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: null, spawnToken: 'spawn-a' }
    }
    const proof = proofWith(settlement(), spawned)
    expect(proof.owner.kind).toBe('failed-acquisition')
    expect(structuredAgentSessionAcquisitionProbe(spawned, proof)).toEqual({
      outcome: 'exit-observed'
    })
    expect(proofWith(settlement(), spawned, 'ssh:devbox').owner).toEqual({ kind: 'none' })
  })

  it('speaks for an unrecorded spawn whose exit went unproven, which its settlement releases', () => {
    expect(proofWith(settlement({ exitProof: 'unproven' })).owner).toMatchObject({
      kind: 'failed-acquisition',
      exitProof: 'unproven'
    })
  })

  it('speaks for a recorded owner whose exit went unproven, which its settlement parks', () => {
    const spawned = {
      ...RESERVATION,
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: null, spawnToken: 'spawn-a' }
    }
    const proof = proofWith(settlement({ exitProof: 'unproven' }), spawned)
    expect(proof.owner).toMatchObject({ kind: 'failed-acquisition', exitProof: 'unproven' })
    // Never proof of death to an acquisition: the swap refuses as it would on the parked lease.
    expect(structuredAgentSessionAcquisitionProbe(spawned, proof)).toMatchObject({
      outcome: 'indeterminate'
    })
  })

  it.each([
    ['another fence', settlement({ fence: 3 })],
    ['another operation', settlement({ operationId: 'op-2' })],
    ['another spawn token', settlement({ spawnToken: 'spawn-b' })]
  ] as const)('proves nothing from %s', (_label, unsettled) => {
    expect(proofWith(unsettled).owner).toEqual({ kind: 'none' })
  })
})
