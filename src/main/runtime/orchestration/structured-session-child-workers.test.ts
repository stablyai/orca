import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import { OrchestrationDb } from './db'
import { structuredSessionChildWorkers } from './structured-session-child-workers'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'

const PARENT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const WORKER = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
const OTHER = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
const CLEARED = testOrcaSessionId('2e8b4d61-5a3c-4e97-b0f2-7c1d9a6e3b54')
let db: OrchestrationDb
let records: Map<string, AgentSessionRecord>
const reader = {
  getRecord: (id: string) =>
    records.has(id) ? agentSessionConversationView(records.get(id)!) : null,
  listRecords: () => [...records.values()].map(agentSessionConversationView)
}

function record(sessionId: string): AgentSessionRecord {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return { ...base, location: { ...base.location, workspaceKind: 'folder' } }
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  records = new Map([PARENT, WORKER, OTHER].map((id) => [id, record(id)]))
})
afterEach(() => db.close())

function start(sessionId: OrcaSessionId, creator = PARENT, runId?: string) {
  const run =
    runId ??
    db.createRun({
      objective: 'parent',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: creator
    }).id
  const started = db.createStartingWorkerDispatch({
    taskSpec: 'Inspect full conversation',
    taskTitle: 'Review',
    taskRunId: run,
    startOptions: {},
    creator: { kind: 'session', orcaSessionId: creator },
    maxDepth: 100
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: mintStructuredWorkerHandle(),
    paneKey: mintStructuredWorkerPaneKey(sessionId),
    processIncarnation: structuredWorkerProcessIncarnation(sessionId),
    worktreeId: 'workspace-1',
    effects: [],
    setupState: 'ready',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  return started
}

function children(sessionId = PARENT, dispatchId?: string, cursor?: string) {
  return structuredSessionChildWorkers({ db, records: reader, sessionId, dispatchId, cursor })
}

describe('supervised conversations', () => {
  it('links separate cross-provider sessions by recorded creator, across runs and folder workspaces', () => {
    records.set(WORKER, { ...record(WORKER), provider: 'codex' })
    const own = start(WORKER)
    const unrelated = start(OTHER, OTHER)
    db.db
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
      .run('2026-10-24 17:00:00', own.dispatch.id)
    const before = db.getDispatchContextById(own.dispatch.id)
    expect(children().children).toMatchObject([
      {
        runId: own.dispatch.run_id,
        taskId: own.task.id,
        dispatchId: own.dispatch.id,
        state: 'working',
        conversation: {
          kind: 'journal',
          sessionId: WORKER,
          agent: 'codex',
          workspaceId: 'workspace-1'
        }
      }
    ])
    expect(children().children.some((row) => row.dispatchId === unrelated.dispatch.id)).toBe(false)
    expect(children().children[0]?.startedAt).toBe(Date.parse('2026-10-24T17:00:00Z'))
    expect(db.getDispatchContextById(own.dispatch.id)).toEqual(before)
    expect(records.get(WORKER)?.lease).toEqual(record(WORKER).lease)
  })

  it('retains completed/released result and reads the full durable journal identity after custody ends', () => {
    const own = start(WORKER)
    expect(
      db.settleWorkerReport({
        taskId: own.task.id,
        dispatchId: own.dispatch.id,
        outcome: 'succeeded',
        result: 'Original recorded result'
      }).action
    ).toBe('settled')
    const resource = db.getWorkerTerminalResourceByOwner(own.dispatch.id)!
    expect(
      db.settleDeadWorkerTerminalRelease({
        requestingDispatchId: own.dispatch.id,
        resourceId: resource.id,
        processIncarnation: resource.process_incarnation!
      }).disposition
    ).toBe('released')
    const released = record(WORKER)
    records.set(WORKER, {
      ...released,
      lease: { ...released.lease, claimStatus: 'released', ownerProcess: null }
    })
    expect(children().children).toMatchObject([
      {
        dispatchId: own.dispatch.id,
        state: 'completed',
        result: 'Original recorded result',
        conversation: { kind: 'journal', sessionId: WORKER }
      }
    ])
    expect(db.getWorkerTerminalResourceByOwner(own.dispatch.id)?.release_state).toBe('released')
  })

  it('keeps nested workers under the exact parent attempt and excludes sibling, self and unrelated runs', () => {
    const own = start(WORKER)
    const nested = start(OTHER, WORKER, own.dispatch.run_id)
    expect(db.getDispatchContextById(nested.dispatch.id)?.creator_dispatch_id).toBe(own.dispatch.id)
    expect(children(PARENT).children.map((row) => row.dispatchId)).toEqual([own.dispatch.id])
    expect(children(WORKER, own.dispatch.id).children.map((row) => row.dispatchId)).toEqual([
      nested.dispatch.id
    ])
    expect(() => children(OTHER, own.dispatch.id)).toThrow('does not name this conversation')
    expect(() => children(PARENT, undefined, nested.dispatch.id)).toThrow('another conversation')
  })

  it('follows committed clear lineage while preserving the original parent and Dispatch authority', () => {
    const own = start(WORKER)
    const old = record(WORKER)
    records.set(WORKER, {
      ...old,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: CLEARED,
        operationId: 'op',
        callerKey: 'k',
        phase: 'committed'
      }
    })
    records.set(CLEARED, record(CLEARED))
    expect(children().children[0]?.conversation).toMatchObject({
      kind: 'journal',
      sessionId: CLEARED
    })
    expect(children(CLEARED, own.dispatch.id).children).toEqual([])
  })

  it.each(['remote', 'malformed', 'identity', 'record-missing', 'other-host'] as const)(
    'refuses %s history even when a matching local session could exist',
    (reason) => {
      const own = start(WORKER)
      if (reason === 'remote' || reason === 'malformed') {
        db.db
          .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
          .run(
            reason === 'remote'
              ? JSON.stringify({ kind: 'ssh', targetId: 'server' })
              : 'unreadable-host',
            own.dispatch.id
          )
      }
      if (reason === 'identity') {
        db.db
          .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
          .run(structuredWorkerProcessIncarnation(OTHER), own.dispatch.id)
      }
      if (reason === 'record-missing') {
        records.delete(WORKER)
      }
      if (reason === 'other-host') {
        records.set(WORKER, {
          ...record(WORKER),
          location: { ...record(WORKER).location, executionHostId: 'ssh:server' }
        })
      }
      expect(children().children[0]?.conversation.kind).toBe('unavailable')
    }
  )

  it('exposes terminal-only and still-starting workers without fabricating a transcript', () => {
    const run = db.createRun({
      objective: 'work',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: PARENT
    })
    const pending = db.createStartingWorkerDispatch({
      taskSpec: 'pending',
      taskRunId: run.id,
      startOptions: {},
      creator: { kind: 'session', orcaSessionId: PARENT },
      maxDepth: 10
    })
    expect(children().children).toMatchObject([
      {
        dispatchId: pending.dispatch.id,
        workerState: 'starting',
        conversation: { kind: 'unavailable' }
      }
    ])
    db.prepareStartingWorkerAuthority({
      dispatchId: pending.dispatch.id,
      handle: 'term_external',
      paneKey: 'tab:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'pty:1',
      worktreeId: 'workspace-1',
      effects: [],
      setupState: 'ready'
    })
    db.markWorkerDispatchReady(pending.dispatch.id)
    expect(children().children[0]?.conversation).toEqual({
      kind: 'unavailable',
      reason: 'terminal-worker'
    })
  })

  it('pages every durable attempt without losing older workers', () => {
    const run = db.createRun({
      objective: 'Many workers',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: PARENT
    })
    const attempts = Array.from(
      { length: 103 },
      (_, index) =>
        db.createStartingWorkerDispatch({
          taskSpec: `worker ${index}`,
          taskRunId: run.id,
          startOptions: {},
          creator: { kind: 'session', orcaSessionId: PARENT },
          maxDepth: 10
        }).dispatch.id
    )
    const newest = children()
    const older = children(PARENT, undefined, newest.nextCursor!)
    const read = [...newest.children, ...older.children].map((child) => child.dispatchId)
    expect(read).toEqual(attempts.toReversed())
    expect(new Set(read).size).toBe(103)
    expect(older.nextCursor).toBeNull()
  })

  it('keeps a failed attempt’s recorded result distinct from a successful retry', () => {
    const first = start(WORKER)
    db.settleWorkerReport({
      taskId: first.task.id,
      dispatchId: first.dispatch.id,
      outcome: 'failed',
      result: 'Original failure report'
    })
    const retry = db.createStartingWorkerDispatch({
      taskId: first.task.id,
      retryOf: first.dispatch.id,
      startOptions: {},
      creator: { kind: 'session', orcaSessionId: PARENT },
      maxDepth: 10
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: retry.dispatch.id,
      handle: mintStructuredWorkerHandle(),
      paneKey: mintStructuredWorkerPaneKey(OTHER),
      processIncarnation: structuredWorkerProcessIncarnation(OTHER),
      worktreeId: 'workspace-1',
      effects: [],
      setupState: 'ready'
    })
    db.markWorkerDispatchReady(retry.dispatch.id)
    db.settleWorkerReport({
      taskId: first.task.id,
      dispatchId: retry.dispatch.id,
      outcome: 'succeeded',
      result: 'New success report'
    })
    expect(children().children).toMatchObject([
      { dispatchId: retry.dispatch.id, result: 'New success report', state: 'completed' },
      { dispatchId: first.dispatch.id, result: 'Original failure report', state: 'failed' }
    ])
  })
})
