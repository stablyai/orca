import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { OrchestrationDb } from './db'
import { structuredSessionChildWorkers } from './structured-session-child-workers'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'

const PARENT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const WORKER = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
const LOCAL = JSON.stringify({ kind: 'local', hostId: 'local' })
let db: OrchestrationDb
let records: Map<string, AgentSessionRecord>
let runId: string

function record(provider: string): AgentSessionRecord {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: WORKER }))
  return { ...base, provider, location: { ...base.location, workspaceKind: 'folder' } }
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  const parent = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: PARENT }))
  records = new Map([[PARENT, parent]])
  runId = db.createRun({
    objective: 'Inspect worker metadata',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: PARENT
  }).id
})
afterEach(() => db.close())

function start(
  args: {
    agent?: unknown
    hostScope?: string | null
    session?: AgentSessionRecord
    federation?: Parameters<OrchestrationDb['createStartingWorkerDispatch']>[0]['federation']
  } = {}
) {
  const started = db.createStartingWorkerDispatch({
    taskSpec: 'Review retained identity',
    taskRunId: runId,
    startOptions: { agent: args.agent ?? null },
    creator: { kind: 'session', orcaSessionId: PARENT },
    maxDepth: 10,
    federation: args.federation
  })
  if (args.session) {
    records.set(WORKER, args.session)
  }
  if (args.federation) {
    db.updateFederatedDispatchResources({
      dispatchId: started.dispatch.id,
      remoteRuntimeEpoch: 'remote-epoch',
      worktreeId: 'remote-folder',
      terminalHandle: 'term_remote'
    })
    db.reconcileFederatedWorkerStart({
      dispatchId: started.dispatch.id,
      state: 'ready',
      stage: 'ready',
      worktreeId: 'remote-folder',
      terminalHandle: 'term_remote'
    })
    return started
  }
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: args.session ? mintStructuredWorkerHandle() : 'term_worker',
    paneKey: args.session
      ? mintStructuredWorkerPaneKey(WORKER)
      : 'tab:11111111-1111-4111-8111-111111111111',
    processIncarnation: args.session ? structuredWorkerProcessIncarnation(WORKER) : 'pty:1',
    worktreeId: 'workspace-1',
    effects: [],
    setupState: 'ready',
    hostScope: args.hostScope,
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  return started
}

function children() {
  return structuredSessionChildWorkers({
    db,
    records: {
      getRecord: (id) => (records.has(id) ? agentSessionConversationView(records.get(id)!) : null),
      listRecords: () => [...records.values()].map(agentSessionConversationView)
    },
    sessionId: PARENT
  }).children
}

describe('retained supervised worker metadata', () => {
  it.each(['claude', 'codex'])(
    'keeps the recorded local %s provider and folder host beside the exact journal',
    (provider) => {
      const own = start({ session: record(provider), hostScope: LOCAL })
      const before = db.db.prepare('SELECT * FROM dispatch_contexts').all()
      const expected = {
        metadata: { agent: provider, executionHost: { kind: 'local' } },
        conversation: { kind: 'journal', sessionId: WORKER, agent: provider }
      }
      expect(children()[0]).toMatchObject(expected)
      expect(db.db.prepare('SELECT * FROM dispatch_contexts').all()).toEqual(before)
      db.settleWorkerReport({
        taskId: own.task.id,
        dispatchId: own.dispatch.id,
        outcome: 'succeeded',
        result: 'Retained structured result'
      })
      const resource = db.getWorkerTerminalResourceByOwner(own.dispatch.id)!
      expect(
        db.settleDeadWorkerTerminalRelease({
          requestingDispatchId: own.dispatch.id,
          resourceId: resource.id,
          processIncarnation: resource.process_incarnation!
        }).disposition
      ).toBe('released')
      expect(children()[0]).toMatchObject({ ...expected, result: 'Retained structured result' })
    }
  )

  it.each([
    { kind: 'local', hostId: 'local' },
    { kind: 'wsl', hostId: 'local', distro: 'Ubuntu-24.04' },
    { kind: 'ssh', targetId: 'ssh-review-box' }
  ] as const)('keeps terminal %s identity and result before and after release', (scope) => {
    const own = start({ agent: 'opencode', hostScope: JSON.stringify(scope) })
    const expectedHost =
      scope.kind === 'local'
        ? { kind: 'local' }
        : scope.kind === 'wsl'
          ? { kind: 'wsl', distro: scope.distro }
          : { kind: 'ssh', targetId: scope.targetId }
    const expected = {
      metadata: { agent: 'opencode', executionHost: expectedHost },
      conversation: {
        kind: 'unavailable',
        reason: scope.kind === 'local' ? 'terminal-worker' : 'remote-worker'
      }
    }
    expect(children()[0]).toMatchObject(expected)
    db.settleWorkerReport({
      taskId: own.task.id,
      dispatchId: own.dispatch.id,
      outcome: 'succeeded',
      result: 'Retained terminal result'
    })
    const resource = db.getWorkerTerminalResourceByOwner(own.dispatch.id)!
    expect(
      db.settleDeadWorkerTerminalRelease({
        requestingDispatchId: own.dispatch.id,
        resourceId: resource.id,
        processIncarnation: resource.process_incarnation!
      }).disposition
    ).toBe('released')
    expect(children()[0]).toMatchObject({ ...expected, result: 'Retained terminal result' })
  })

  it('keeps the federated environment label without borrowing a colliding local session', () => {
    const own = start({
      agent: 'codex',
      federation: {
        environmentId: 'environment-review',
        environmentName: 'Build Linux',
        peerFingerprint: 'peer-review',
        protocolVersion: 1
      }
    })
    records.set(WORKER, record('claude'))
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(WORKER, own.dispatch.id)
    const expected = {
      metadata: {
        agent: 'codex',
        executionHost: {
          kind: 'environment',
          environmentId: 'environment-review',
          label: 'Build Linux'
        }
      },
      conversation: { kind: 'unavailable', reason: 'remote-worker' }
    }
    expect(children()[0]).toMatchObject(expected)
    db.settleWorkerReport({
      taskId: own.task.id,
      dispatchId: own.dispatch.id,
      outcome: 'succeeded',
      result: 'Retained federated result'
    })
    db.transitionLifecycle({
      entity: 'worker',
      id: own.dispatch.id,
      from: 'succeeded',
      to: 'succeeded',
      projection: { stage: 'released', agent_terminal_handle: null }
    })
    db.db
      .prepare(
        'UPDATE federated_dispatches SET remote_terminal_handle = NULL WHERE dispatch_id = ?'
      )
      .run(own.dispatch.id)
    expect(db.getWorkerTerminalResourceByOwner(own.dispatch.id)).toBeUndefined()
    expect(children()[0]).toMatchObject({ ...expected, result: 'Retained federated result' })
  })

  it('retains a matching remote session provider without granting local journal access', () => {
    const remote = record('codex')
    start({
      session: {
        ...remote,
        location: { ...remote.location, executionHostId: 'ssh:ssh-review-box' }
      },
      hostScope: JSON.stringify({ kind: 'ssh', targetId: 'ssh-review-box' })
    })
    expect(children()[0]).toMatchObject({
      metadata: { agent: 'codex', executionHost: { kind: 'ssh', targetId: 'ssh-review-box' } },
      conversation: { kind: 'unavailable', reason: 'remote-worker' }
    })
  })

  it('does not infer a host from a federated row without an environment identity', () => {
    start({
      federation: {
        environmentId: ' ',
        environmentName: 'Unknown environment',
        peerFingerprint: 'peer-review',
        protocolVersion: 1
      }
    })
    expect(children()[0]?.metadata).toBeUndefined()
    expect(children()[0]?.conversation).toEqual({ kind: 'unavailable', reason: 'remote-worker' })
  })

  it.each([
    { agent: ['codex'], hostScope: 'broken-scope' },
    { agent: ' codex ', hostScope: JSON.stringify({ kind: 'wsl', hostId: 'local' }) },
    { agent: null, hostScope: JSON.stringify({ kind: 'wsl', hostId: 'local', distro: ' ' }) },
    { agent: 'launch-alias', hostScope: 'unknown-host' }
  ])('leaves malformed or missing identity unknown: %s', (facts) => {
    start(facts)
    expect(children()[0]?.metadata).toBeUndefined()
    expect(children()[0]?.conversation.kind).toBe('unavailable')
  })

  it('distinguishes a retained legacy local resource from a launch without host facts', () => {
    start({ agent: 'codex' })
    expect(children()[0]?.metadata).toEqual({ agent: 'codex', executionHost: { kind: 'local' } })
    db.createStartingWorkerDispatch({
      taskSpec: 'Not launched yet',
      taskRunId: runId,
      startOptions: {},
      creator: { kind: 'session', orcaSessionId: PARENT },
      maxDepth: 10
    })
    expect(children()[0]?.metadata).toBeUndefined()
  })

  it('keeps independently known launch identity when retained host scopes disagree', () => {
    const own = start({ agent: 'codex', hostScope: LOCAL })
    db.db
      .prepare('UPDATE worker_terminal_resources SET host_scope = ? WHERE owner_dispatch_id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'other-host' }), own.dispatch.id)
    expect(children()[0]?.metadata).toEqual({ agent: 'codex' })
    expect(children()[0]?.conversation.kind).toBe('unavailable')
  })

  it('does not use a session whose retained process disagrees', () => {
    const own = start({ session: record('claude'), hostScope: LOCAL })
    db.db
      .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
      .run('structured:another-session', own.dispatch.id)
    expect(children()[0]?.metadata).toEqual({ executionHost: { kind: 'local' } })
    expect(children()[0]?.conversation).toEqual({
      kind: 'unavailable',
      reason: 'identity-unverifiable'
    })
  })

  it('does not borrow a colliding local provider for an SSH worker', () => {
    start({
      session: record('claude'),
      hostScope: JSON.stringify({ kind: 'ssh', targetId: 'box' })
    })
    expect(children()[0]?.metadata).toEqual({ executionHost: { kind: 'ssh', targetId: 'box' } })
    expect(children()[0]?.conversation).toEqual({ kind: 'unavailable', reason: 'remote-worker' })
  })

  it('preserves known host facts when launch JSON is unreadable', () => {
    const own = start({ hostScope: LOCAL })
    db.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run('broken-launch-json', own.dispatch.id)
    expect(children()[0]?.metadata).toEqual({ executionHost: { kind: 'local' } })
  })

  it('does not project launch configuration as an executed model', () => {
    const own = start({ agent: 'codex', hostScope: LOCAL })
    db.db.prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?').run(
      JSON.stringify({
        agent: 'codex',
        launch: {
          requested: { agent: 'codex', model: 'requested-model', effort: 'high' },
          effective: { agent: 'codex', model: 'configured-model', effort: 'high' }
        }
      }),
      own.dispatch.id
    )
    expect(children()[0]?.metadata).toEqual({ agent: 'codex', executionHost: { kind: 'local' } })
  })
})
