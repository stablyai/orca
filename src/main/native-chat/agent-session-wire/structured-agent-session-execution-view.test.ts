import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { resolveStructuredAgentSessionExecution as resolve } from './structured-agent-session-execution-view'

const running: AgentJournalRenderItem = {
  itemId: 'turn',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
}
const native = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeKind: 'native' }))
const base = {
  record: native,
  nativeBound: true,
  currentItems: [],
  submissions: [],
  backgroundWork: false
}

describe('host execution view', () => {
  it('distinguishes idle process, live work and current admission before echo', () => {
    expect(resolve(base)).toMatchObject({
      observation: 'live',
      activity: 'idle',
      control: 'native',
      turnId: null
    })
    expect(resolve({ ...base, currentItems: [running] })).toMatchObject({
      activity: 'working',
      turnId: 'turn-1'
    })
    expect(
      resolve({
        ...base,
        submissions: [
          {
            clientMessageId: 'send',
            fence: 7,
            payloadFingerprint: 'x',
            dispatchState: 'pending',
            providerItemId: null,
            reason: null,
            submittedAt: 1,
            resolvedAt: null
          }
        ]
      })
    ).toMatchObject({ activity: 'working', turnId: null })
  })
  it.each(['live', 'unverifiable'] as const)(
    'does not grant native control to a %s orphan',
    (observation) => {
      expect(
        resolve({ ...base, nativeBound: false, observation, currentItems: [running] })
      ).toMatchObject({ observation, activity: 'unverifiable', control: 'none', turnId: null })
    }
  )
  it('keeps terminal control independent of a native child and does not invent its activity', () => {
    expect(
      resolve({
        ...base,
        record: agentSessionRecordFixture(),
        nativeBound: false,
        observation: 'live'
      })
    ).toMatchObject({ observation: 'live', control: 'tui', activity: 'unverifiable' })
  })
  it('revokes history activity before repair and distinguishes never acquired', () => {
    const lease = agentSessionLeaseFixture({
      runtimeKind: 'native',
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null
    })
    expect(
      resolve({
        ...base,
        record: agentSessionRecordFixture(lease),
        nativeBound: false,
        currentItems: [running]
      })
    ).toMatchObject({ observation: 'none', activity: 'idle', control: 'none' })
    expect(
      resolve({
        ...base,
        record: agentSessionRecordFixture({
          ...lease,
          deathEvidence: { kind: 'pid-absent', detail: 'absent', observedAt: 1 }
        }),
        nativeBound: false,
        currentItems: [running]
      })
    ).toMatchObject({ observation: 'exited', activity: 'idle', control: 'none' })
  })
  it('never accepts a bound resource as authority across an unresolved lease', () => {
    expect(
      resolve({
        ...base,
        record: agentSessionRecordFixture({ ...native.lease, unreconciled: true }),
        currentItems: [running]
      })
    ).toMatchObject({ observation: 'unverifiable', activity: 'unverifiable', control: 'none' })
  })
})
