import { beforeEach, describe, expect, it } from 'vitest'
import { AgentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { isAgentSessionPtyWriteRefusedError } from '../../shared/agent-session-pty-write-admission'
import type { AgentSessionLease, AgentSessionRecord } from '../../shared/agent-session-record'

const PTY_ID = 'pty-1'
const SESSION_ID = 'session-alpha-1'

let gate: AgentSessionPtyWriteGate
let records: Map<string, AgentSessionRecord>

function publish(lease: AgentSessionLease): void {
  records.set(lease.sessionId, agentSessionRecordFixture(lease))
}

beforeEach(() => {
  gate = new AgentSessionPtyWriteGate()
  records = new Map()
})

describe('capability invisibility', () => {
  it('admits every PTY while nothing is bound, which is the shape of today builds', () => {
    gate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
    expect(gate.enforcing).toBe(false)
    expect(gate.admit('any-shell')).toEqual({
      admitted: true,
      sessionId: null,
      runtimeFence: null
    })
  })

  it('admits an unbound PTY even once another PTY is bound and refusing', () => {
    gate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
    publish(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    gate.bindPty(PTY_ID, SESSION_ID)
    expect(gate.admit(PTY_ID).admitted).toBe(false)
    expect(gate.admit('ordinary-shell').admitted).toBe(true)
  })

  it('admits a bound PTY while no store is attached, so a half-wired host cannot refuse', () => {
    gate.bindPty(PTY_ID, SESSION_ID)
    expect(gate.enforcing).toBe(false)
    expect(gate.admit(PTY_ID).admitted).toBe(true)
  })
})

describe('binding lifecycle', () => {
  beforeEach(() => {
    gate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
  })

  it('reports the session a PTY is bound to', () => {
    gate.bindPty(PTY_ID, SESSION_ID)
    expect(gate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    expect(gate.boundSessionId('other')).toBeNull()
  })

  it('returns an unbound PTY to the exempt path when it is unbound', () => {
    publish(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    gate.bindPty(PTY_ID, SESSION_ID)
    expect(gate.admit(PTY_ID).admitted).toBe(false)
    gate.unbindPty(PTY_ID)
    expect(gate.admit(PTY_ID).admitted).toBe(true)
  })

  it('drops every binding when the store detaches', () => {
    publish(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    gate.bindPty(PTY_ID, SESSION_ID)
    gate.detachRecordLookup()
    expect(gate.enforcing).toBe(false)
    expect(gate.admit(PTY_ID).admitted).toBe(true)
  })
})

describe('overlapping adoption attempts on one pane', () => {
  beforeEach(() => {
    gate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
  })

  it('keeps the newer attempt bound when the one it superseded gives up', () => {
    gate.bindPtyForAttempt(PTY_ID, SESSION_ID, 'spawn-a')
    expect(gate.bindPtyForAttempt(PTY_ID, SESSION_ID, 'spawn-b')).toBe(true)

    // Both attempts carry the same session, so only the spawn token can tell this release apart.
    expect(gate.releasePtyAttempt(PTY_ID, 'spawn-a')).toBe(false)
    expect(gate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    expect(gate.releasePtyAttempt(PTY_ID, 'spawn-b')).toBe(true)
    expect(gate.boundSessionId(PTY_ID)).toBeNull()
  })

  it('leaves a settled owner pane alone when a later attempt fails', () => {
    gate.bindPty(PTY_ID, SESSION_ID)

    expect(gate.bindPtyForAttempt(PTY_ID, SESSION_ID, 'spawn-late')).toBe(false)
    expect(gate.releasePtyAttempt(PTY_ID, 'spawn-late')).toBe(false)
    expect(gate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
  })

  it('settles a proven attempt so no later attempt can release its pane', () => {
    gate.bindPtyForAttempt(PTY_ID, SESSION_ID, 'spawn-a')
    expect(gate.settlePtyAttempt(PTY_ID, 'spawn-a')).toBe(true)

    expect(gate.settlePtyAttempt(PTY_ID, 'spawn-a')).toBe(false)
    expect(gate.releasePtyAttempt(PTY_ID, 'spawn-a')).toBe(false)
    expect(gate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
  })

  it('settles nothing once the pane is gone', () => {
    gate.bindPtyForAttempt(PTY_ID, SESSION_ID, 'spawn-a')
    gate.unbindPty(PTY_ID)

    expect(gate.settlePtyAttempt(PTY_ID, 'spawn-a')).toBe(false)
    expect(gate.boundSessionId(PTY_ID)).toBeNull()
  })
})

describe('admission through the store', () => {
  beforeEach(() => {
    gate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
    gate.bindPty(PTY_ID, SESSION_ID)
  })

  it('admits a proven-live TUI owner and reports the fence it was admitted under', () => {
    publish(agentSessionLeaseFixture({ runtimeFence: 11 }))
    expect(gate.admit(PTY_ID)).toEqual({
      admitted: true,
      sessionId: SESSION_ID,
      runtimeFence: 11
    })
  })

  it.each(['preparing', 'old-owner-stopped', 'new-owner-proving'] as const)(
    'refuses TUI writes while handoff stage %s is active',
    (handoffStage) => {
      publish(agentSessionLeaseFixture({ runtimeKind: 'tui', handoffStage }))
      const admission = gate.admit(PTY_ID)
      expect(admission.admitted).toBe(false)
      if (!admission.admitted) {
        expect(admission.refusal).toMatchObject({
          code: 'agent_session_conflict',
          handoffStage,
          ownerRuntimeKind: 'tui'
        })
      }
    }
  )

  it('admits only the reserved TUI proof token while the new process is proving', () => {
    publish(
      agentSessionLeaseFixture({
        runtimeKind: 'tui',
        claimStatus: 'reserved',
        handoffStage: 'new-owner-proving',
        ownerProcess: {
          hostId: 'local',
          pid: 4200,
          processStartTimeMs: 10,
          spawnToken: 'proof-token'
        },
        reservedSpawnToken: 'proof-token'
      })
    )
    expect(gate.admit(PTY_ID).admitted).toBe(false)
    expect(gate.admitProof(PTY_ID, { sessionId: SESSION_ID, spawnToken: 'proof-token' })).toBe(true)
    expect(gate.admitProof(PTY_ID, { sessionId: SESSION_ID, spawnToken: 'wrong-token' })).toBe(
      false
    )
    expect(
      gate.admitProof(PTY_ID, { sessionId: 'session-beta-2', spawnToken: 'proof-token' })
    ).toBe(false)
  })

  it('refuses proof input that does not match the committed process identity', () => {
    publish(
      agentSessionLeaseFixture({
        runtimeKind: 'tui',
        claimStatus: 'reserved',
        handoffStage: 'new-owner-proving',
        ownerProcess: {
          hostId: 'local',
          pid: 4200,
          processStartTimeMs: 10,
          spawnToken: 'other-token'
        },
        reservedSpawnToken: 'proof-token'
      })
    )
    expect(gate.admitProof(PTY_ID, { sessionId: SESSION_ID, spawnToken: 'proof-token' })).toBe(
      false
    )
  })

  it('refuses proof input after ownership is live', () => {
    publish(agentSessionLeaseFixture({ reservedSpawnToken: 'proof-token' }))
    expect(gate.admitProof(PTY_ID, { sessionId: SESSION_ID, spawnToken: 'proof-token' })).toBe(
      false
    )
  })

  it('admits proof input for the exact proven live owner during restore', () => {
    publish(
      agentSessionLeaseFixture({
        ownerProcess: {
          hostId: 'local',
          pid: 4200,
          processStartTimeMs: 10,
          spawnToken: 'live-proof-token'
        },
        reservedSpawnToken: 'live-proof-token'
      })
    )
    expect(gate.admitProof(PTY_ID, { sessionId: SESSION_ID, spawnToken: 'live-proof-token' })).toBe(
      true
    )
    expect(gate.admitProof(PTY_ID, { sessionId: SESSION_ID, spawnToken: 'wrong-token' })).toBe(
      false
    )
  })

  it('refuses when the record vanished from the store', () => {
    const admission = gate.admit(PTY_ID)
    expect(admission.admitted).toBe(false)
  })

  it('throws the typed refusal from assertAdmitted', () => {
    publish(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    let thrown: unknown = null
    try {
      gate.assertAdmitted(PTY_ID)
    } catch (error) {
      thrown = error
    }
    expect(isAgentSessionPtyWriteRefusedError(thrown)).toBe(true)
    if (!isAgentSessionPtyWriteRefusedError(thrown)) {
      return
    }
    expect(thrown.refusal.code).toBe('agent_session_conflict')
    expect(thrown.refusal.ownerRuntimeKind).toBe('native')
  })

  it('returns the admittance from assertAdmitted so later chunks can be fenced', () => {
    publish(agentSessionLeaseFixture({ runtimeFence: 3 }))
    expect(gate.assertAdmitted(PTY_ID)).toEqual({ sessionId: SESSION_ID, runtimeFence: 3 })
  })

  it('throws from assertReadmitted once the lease moved under an in-flight write', () => {
    publish(agentSessionLeaseFixture({ runtimeFence: 3 }))
    const admitted = gate.assertAdmitted(PTY_ID)
    publish(agentSessionLeaseFixture({ runtimeFence: 4 }))
    expect(() => gate.assertReadmitted(PTY_ID, admitted)).toThrowError(
      'agent_session_checkpoint_stale'
    )
  })

  it('lets an in-flight write finish while the lease is unchanged', () => {
    publish(agentSessionLeaseFixture({ runtimeFence: 3 }))
    const admitted = gate.assertAdmitted(PTY_ID)
    expect(() => gate.assertReadmitted(PTY_ID, admitted)).not.toThrow()
  })

  it('leaves an in-flight write on an exempt PTY alone', () => {
    const admitted = gate.assertAdmitted('ordinary-shell')
    expect(admitted).toEqual({ sessionId: null, runtimeFence: null })
    expect(() => gate.assertReadmitted('ordinary-shell', admitted)).not.toThrow()
  })

  it('refuses an exempt write that acquired a refusing binding mid-flight', () => {
    const admitted = gate.assertAdmitted('late-bound')
    publish(agentSessionLeaseFixture({ sessionId: 'session-beta-2', runtimeKind: 'native' }))
    gate.bindPty('late-bound', 'session-beta-2')
    expect(() => gate.assertReadmitted('late-bound', admitted)).toThrow()
  })
})
