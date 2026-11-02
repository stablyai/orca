import { describe, expect, it } from 'vitest'
import type { AgentSessionLease } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { agentSessionReplacedRuntimes } from './agent-session-replaced-runtime'
import type { AgentSessionStoreState } from './agent-session-store-state'

const SESSION = 'session-alpha-1'
const OWNER = { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-owner' }

function loaded(lease: Partial<AgentSessionLease>, runtimeEnd?: 'crash'): AgentSessionStoreState {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ unreconciled: true, ...lease })
  )
  return {
    records: new Map([[SESSION, record]]),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null,
    runtimeEnds: runtimeEnd ? new Map([['earlier', runtimeEnd]]) : new Map()
  }
}

function replacedFor(state: AgentSessionStoreState) {
  return agentSessionReplacedRuntimes(state, {
    hostId: 'local',
    incarnation: 'this-runtime'
  }).get(SESSION)
}

describe('the runtimes a new server replaced, as it loads their records', () => {
  it('names every fence an earlier runtime granted, its owner renewal, and how it ended', () => {
    expect(
      replacedFor(loaded({ ownerProcess: { ...OWNER, runtime: 'earlier' } }, 'crash'))
    ).toEqual({ fence: 7, lastProvenAliveAt: 30_000, runtimeEnd: 'crash' })
  })

  it('covers a chat an earlier runtime released, which no owner holds now', () => {
    expect(
      replacedFor(loaded({ ownerProcess: null, reservedSpawnToken: null, claimStatus: 'released' }))
    ).toEqual({ fence: 7 })
  })

  it.each([
    ['an owner this runtime recorded', { ownerProcess: { ...OWNER, runtime: 'this-runtime' } }],
    ['an owner on another host', { ownerProcess: { ...OWNER, hostId: 'remote' } }],
    ['a terminal agent an older build recorded', { claimStatus: 'conflicted' as const }]
  ])('replaces nothing for %s', (_label, lease) => {
    expect(replacedFor(loaded(lease))).toBeUndefined()
  })
})
