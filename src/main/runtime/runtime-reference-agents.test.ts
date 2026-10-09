import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  createReferenceAgentIndex,
  referenceConnectionHosts,
  type ReferenceAgentSource
} from './runtime-reference-agents'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'

const observations = vi.hoisted<{ status: 'live' | 'exited' | 'unverifiable'; reachable: boolean }>(
  () => ({
    status: 'live',
    reachable: true
  })
)
vi.mock('./structured-worker-authority', () => ({
  observeStructuredSession: () => ({ status: observations.status })
}))
vi.mock('./orchestration/structured-session-mail-address', () => ({
  structuredSessionMailReach: () => ({ kind: observations.reachable ? 'reachable' : 'ended' })
}))
vi.mock('./agent-session-record-store-slot', () => ({
  peekOpenedAgentSessionRecordStore: () => null
}))

function evidence(overrides: Partial<FleetAgentStatusEvidence> = {}): FleetAgentStatusEvidence {
  return {
    binding: {
      kind: 'worker',
      dispatchId: 'worker-1',
      terminalHandle: 'term_exact',
      paneKey: 'pane',
      processIncarnation: 'incarnation'
    },
    clock: { kind: 'observed', at: 10 },
    deliveredAt: 10,
    activity: {
      paneKey: 'pane',
      connectionId: null,
      state: 'working',
      agentType: 'codex',
      model: null,
      worktreeId: 'workspace-1',
      restoredUnconfirmed: false,
      providerSessionOnly: false
    },
    ...overrides
  }
}

function runtime(rows: FleetAgentStatusEvidence[]): ReferenceAgentSource {
  return {
    getOrchestrationFleetAgentStatusSnapshot: () => rows,
    getAgentProviderSessionRows: () => [],
    getTerminalLivenessVerdict: () => ({ status: 'unverifiable', reason: 'host disconnected' })
  }
}

function sessionStore(records: AgentSessionRecord[]) {
  return {
    listRecords: () => records,
    getRecord: (id: string) => records.find((record) => record.sessionId === id) ?? null
  }
}

describe('reference agent discovery', () => {
  beforeEach(() => {
    observations.status = 'live'
    observations.reachable = true
  })

  it('returns only fenced terminal handles and worker mailboxes, preserving uncertain liveness', () => {
    const bound = evidence()
    const stale = evidence({
      binding: { kind: 'unresolved', reason: 'stale_incarnation' },
      activity: { ...bound.activity, paneKey: 'old' }
    })
    const index = createReferenceAgentIndex(runtime([bound, stale]), null, null)
    expect(index.get('local|workspace-1')).toMatchObject([
      { terminal: 'term_exact', mailbox: 'dispatch:worker-1', liveness: 'unverifiable' },
      { liveness: 'unverifiable' }
    ])
    expect(index.get('local|workspace-1')?.[1]).not.toHaveProperty('terminal')
    expect(index.get('local|workspace-1')?.[1]).not.toHaveProperty('mailbox')
  })

  it('keeps remote observations under their execution host and does not infer exit', () => {
    const remote = evidence()
    remote.activity.connectionId = 'build server'
    const index = createReferenceAgentIndex(runtime([remote]), null, null)
    expect(index.has('local|workspace-1')).toBe(false)
    expect(index.get('ssh:build%20server|workspace-1')?.[0].liveness).toBe('unverifiable')
  })

  it('joins provider sessions to the exact observation and excludes stale resume-only rows', () => {
    const current: AgentStatusIpcPayload = {
      state: 'working',
      prompt: '',
      agentType: 'codex',
      paneKey: 'pane',
      connectionId: null,
      worktreeId: 'workspace-1',
      receivedAt: 10,
      stateStartedAt: 1,
      providerSession: { key: 'session_id', id: 'current-session' }
    }
    const source = runtime([
      evidence({ deliveredAt: 9, binding: { kind: 'unresolved', reason: 'stale_incarnation' } }),
      evidence()
    ])
    source.getAgentProviderSessionRows = () => [
      current,
      {
        ...current,
        receivedAt: 9,
        providerSession: { key: 'session_id', id: 'old-session' }
      },
      {
        ...current,
        providerSessionOnly: true,
        providerSession: { key: 'session_id', id: 'resume-session' }
      }
    ]
    expect(
      createReferenceAgentIndex(source, null, null).get('local|workspace-1')?.[0]
    ).toMatchObject({ terminal: 'term_exact', sessionIds: ['current-session'] })
    source.getAgentProviderSessionRows = () => [
      current,
      { ...current, providerSession: { key: 'session_id', id: 'ambiguous-session' } }
    ]
    expect(
      createReferenceAgentIndex(source, null, null).get('local|workspace-1')?.[0]
    ).not.toHaveProperty('sessionIds')
  })

  it('filters agent discovery to matched workspaces and honors runtime execution hosts', () => {
    const row = evidence()
    row.activity.connectionId = 'vm-transport'
    const source = runtime([row])
    const hosts = new Map([['vm-transport', 'runtime:env-1' as const]])
    expect(
      createReferenceAgentIndex(
        source,
        null,
        null,
        new Set(['runtime:env-1|workspace-1']),
        hosts
      ).get('runtime:env-1|workspace-1')
    ).toHaveLength(1)
    expect(
      createReferenceAgentIndex(source, null, null, new Set(['local|other']), hosts).size
    ).toBe(0)
    expect(
      createReferenceAgentIndex(source, null, null, undefined, new Map([['vm-transport', null]]))
        .size
    ).toBe(0)
    expect(
      createReferenceAgentIndex(
        runtime([]),
        null,
        sessionStore([agentSessionRecordFixture()]),
        new Set(['local|other'])
      ).size
    ).toBe(0)
  })

  it('maps known transport connections and rejects conflicting host ownership', () => {
    const repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'api',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'vm',
      executionHostId: 'runtime:env' as const
    }
    expect(referenceConnectionHosts([repo]).get('vm')).toBe('runtime:env')
    expect(
      referenceConnectionHosts([repo, { ...repo, executionHostId: 'ssh:other' }]).get('vm')
    ).toBeNull()
  })

  it('returns native session addresses and provider identity without inventing terminal handles', () => {
    const record = agentSessionRecordFixture()
    const index = createReferenceAgentIndex(runtime([]), null, sessionStore([record]))
    expect(index.get('local|workspace-1')?.[0]).toMatchObject({
      mailbox: `orca_session_id:${record.sessionId}`,
      sessionId: record.sessionId,
      liveness: 'live',
      sessionIds: [record.sessionId, 'provider-session-alpha-1']
    })
    expect(index.get('local|workspace-1')?.[0]).not.toHaveProperty('terminal')
  })

  it('keeps closed or unobservable native sessions listed without a delivery address', () => {
    observations.status = 'exited'
    observations.reachable = false
    const record = agentSessionRecordFixture()
    const index = createReferenceAgentIndex(runtime([]), null, sessionStore([record]))
    expect(index.get('local|workspace-1')?.[0].liveness).toBe('exited')
    expect(index.get('local|workspace-1')?.[0]).not.toHaveProperty('mailbox')
  })

  it('skips native records whose chat tab was closed', () => {
    const open = agentSessionRecordFixture()
    const closed = { ...agentSessionRecordFixture(), sessionId: 'closed-session' }
    const store = {
      ...sessionStore([open, closed]),
      getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [open.sessionId] })
    }
    const fleet = evidence()
    fleet.activity.paneKey = structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(closed.sessionId),
      closed.sessionId
    )
    const candidates = createReferenceAgentIndex(runtime([fleet]), null, store).get(
      'local|workspace-1'
    )
    // The closed record's pane is not claimed, so a terminal agent there still surfaces.
    expect(candidates?.map((candidate) => candidate.sessionId ?? candidate.terminal)).toEqual([
      open.sessionId,
      'term_exact'
    ])
  })

  it('does not claim authority over WSL or remote native records', () => {
    const record = agentSessionRecordFixture()
    record.location.wslDistro = 'Ubuntu'
    const candidate = createReferenceAgentIndex(runtime([]), null, sessionStore([record])).get(
      'local|workspace-1'
    )?.[0]
    expect(candidate?.liveness).toBe('unverifiable')
    expect(candidate).not.toHaveProperty('mailbox')
  })
})
