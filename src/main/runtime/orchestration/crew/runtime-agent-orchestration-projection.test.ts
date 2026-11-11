import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'
import 'node:fs'
import 'node:os'
import 'node:path'
import '../../agent-session/records/agent-session-record-store-test-harness'
import '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import '../../agent-session/records/agent-session-record-store-slot'
import '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import '../../orca-runtime'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import '../../rpc/orchestration-session-caller-test-fixture'
import '../../../../shared/orca-session-address'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import '../db/dispatch-predicate-visits.test-fixture'
import './runtime-agent-orchestration-benchmark.test-fixture'
import { MIRROR_LEAVES_STEP_1 } from '../../terminal/records/runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord } from '../../terminal/records/runtime-terminal-state-records'
import { OrchestrationDb } from '../db/orchestration-db'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../terminal-authority/structured-sessions/structured-worker-identity'

const COORDINATOR_CHAT = testOrcaSessionId('1b6f0c3a-7d2e-4a91-8c55-2e9d4b7a0f13')
const WORKER_CHAT = testOrcaSessionId('9c3e5a17-4b2d-4f60-8e91-0d7a6c2b5e48')
const TERMINAL_WORKER_HANDLE = 'term_worker'
const TERMINAL_WORKER_PANE = 'tab_w:11111111-1111-4111-8111-111111111111'

afterEach(() => vi.restoreAllMocks())

function chatRow(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

describe('RuntimeAgentOrchestrationProjection chat lineage', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
    hostRef.current = null
    vi.restoreAllMocks()
  })

  it('nests chat and terminal workers under the chat that dispatched them', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'chat run',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORDINATOR_CHAT
    })
    const chatWorker = {
      handle: mintStructuredWorkerHandle(),
      sessionId: WORKER_CHAT,
      paneKey: mintStructuredWorkerPaneKey(WORKER_CHAT)
    }
    const creator = { kind: 'session', orcaSessionId: COORDINATOR_CHAT } as const
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'chat worker' }).id,
      assigneeHandle: chatWorker.handle,
      assigneePaneKey: chatWorker.paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(WORKER_CHAT),
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'terminal worker' }).id,
      assigneeHandle: TERMINAL_WORKER_HANDLE,
      assigneePaneKey: TERMINAL_WORKER_PANE,
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const leaf: RuntimeLeafRecord = { ...MIRROR_LEAVES_STEP_1[0], ptyId: 'pty_w' }
    const projection = new RuntimeAgentOrchestrationProjection({
      getDb: () => db,
      getLeaves: () => [leaf],
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: () => TERMINAL_WORKER_HANDLE,
      issuePtyHandle: () => '',
      makePaneKey: () => TERMINAL_WORKER_PANE,
      getWorktreeId: (handle) => (handle === TERMINAL_WORKER_HANDLE ? leaf.worktreeId : null),
      getHandleForPaneKey: (pane) =>
        pane === TERMINAL_WORKER_PANE ? TERMINAL_WORKER_HANDLE : null,
      getPaneKey: (handle) => (handle === TERMINAL_WORKER_HANDLE ? TERMINAL_WORKER_PANE : null),
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => null
    })

    const contexts = projection.buildByPaneKey()

    expect(contexts?.[chatRow(WORKER_CHAT)]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    expect(contexts?.[TERMINAL_WORKER_PANE]?.parentPaneKey).toBe(chatRow(COORDINATOR_CHAT))
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)).toEqual(contexts?.[TERMINAL_WORKER_PANE])
    expect(projection.getForPaneKey(chatRow(WORKER_CHAT))).toEqual(contexts?.[chatRow(WORKER_CHAT)])
    // The minted pane key authorizes the worker's mailbox; it must never reach a renderer.
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.paneKey)
    expect(JSON.stringify(contexts)).not.toContain(chatWorker.handle)
  })
})

describe('keyed orchestration presentation', () => {
  it('reads current task facts across commits, rollback and completion expiry', () => {
    const db = new OrchestrationDb(':memory:')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-09T12:00:00Z'))
    try {
      const run = db.createRun({
        objective: 'Keyed presentation',
        coordinatorHandle: 'coordinator',
        coordinatorPaneKey: null
      })
      const task = db.createTask({ runId: run.id, spec: 'Original title' })
      const dispatch = db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: TERMINAL_WORKER_HANDLE,
        assigneePaneKey: TERMINAL_WORKER_PANE,
        creator: { kind: 'system' },
        maxDepth: 99
      })
      const projection = new RuntimeAgentOrchestrationProjection({
        getDb: () => db,
        getLeaves: () => [],
        getPtys: () => [],
        paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
        issueLeafHandle: () => '',
        issuePtyHandle: () => '',
        makePaneKey: () => '',
        getWorktreeId: (handle) => (handle === TERMINAL_WORKER_HANDLE ? 'folder:/workspace' : null),
        getHandleForPaneKey: (pane) =>
          pane === TERMINAL_WORKER_PANE ? TERMINAL_WORKER_HANDLE : null,
        getPaneKey: (handle) => (handle === TERMINAL_WORKER_HANDLE ? TERMINAL_WORKER_PANE : null),
        getDispatchAuthority: () => null,
        getAgentStatusSnapshot: () => [],
        getAgentStatusForPaneKey: () => [],
        getSessionRecords: () => null
      })
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe('Original title')
      db.db.prepare('UPDATE tasks SET task_title = ? WHERE id = ?').run('Committed title', task.id)
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe('Committed title')
      expect(() =>
        runLifecycleWriteTransaction(db.db, 'projection_rollback', () => {
          db.db
            .prepare('UPDATE tasks SET task_title = ? WHERE id = ?')
            .run('Rolled back title', task.id)
          expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe(
            'Rolled back title'
          )
          throw new Error('rollback')
        })
      ).toThrow('rollback')
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe('Committed title')
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'completed', completed_at = ? WHERE id = ?")
        .run('2026-11-09 12:00:00', dispatch.id)
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.dispatchStatus).toBe('completed')
      clock.mockReturnValue(Date.parse('2026-11-10T12:00:00Z'))
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)).toBeUndefined()
      clock.mockReturnValue(Date.parse('2026-11-09T12:00:00Z'))
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.dispatchId).toBe(dispatch.id)
    } finally {
      db.close()
      clock.mockRestore()
    }
  })
})

function terminalProjection(db: OrchestrationDb) {
  const panes = new Map([
    [TERMINAL_WORKER_HANDLE, TERMINAL_WORKER_PANE],
    ['creator', 'tab-creator:cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ['coordinator', 'tab-coordinator:dddddddd-dddd-4ddd-8ddd-dddddddddddd']
  ])
  return new RuntimeAgentOrchestrationProjection({
    getDb: () => db,
    getLeaves: () => [],
    getPtys: () => [],
    paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
    issueLeafHandle: () => '',
    issuePtyHandle: () => '',
    makePaneKey: () => '',
    getWorktreeId: (handle) => (panes.has(handle) ? 'folder:/workspace' : null),
    getHandleForPaneKey: (pane) => [...panes].find(([, key]) => key === pane)?.[0] ?? null,
    getPaneKey: (handle) => panes.get(handle) ?? null,
    getDispatchAuthority: (handle) => ({
      paneKey: panes.get(handle)!,
      processIncarnation: 'creator-process',
      runtimeId: 'runtime',
      terminalHandle: handle,
      ptyId: `pty-${handle}`,
      worktreeId: 'folder:/workspace',
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' }
    }),
    getAgentStatusSnapshot: () => [],
    getAgentStatusForPaneKey: () => [],
    getSessionRecords: () => null
  })
}

it('updates child nesting when its creator dispatch settles without a child task write', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'Creator proof',
      coordinatorHandle: 'coordinator',
      coordinatorPaneKey: 'tab-coordinator:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    })
    const creator = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'Creator' }).id,
      assigneeHandle: 'creator',
      assigneePaneKey: 'tab-creator:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      processIncarnation: 'creator-process',
      creator: { kind: 'system' },
      maxDepth: 99
    })
    const task = db.createTask({ runId: run.id, spec: 'Child' })
    db.db
      .prepare(
        `UPDATE tasks SET created_by_terminal_handle = 'creator', created_by_pane_key = 'tab-creator:cccccccc-cccc-4ccc-8ccc-cccccccccccc', created_by_process_incarnation = 'creator-process', created_by_run_generation = ? WHERE id = ?`
      )
      .run(run.consumer_generation, task.id)
    db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: TERMINAL_WORKER_HANDLE,
      assigneePaneKey: TERMINAL_WORKER_PANE,
      creator: { kind: 'system' },
      maxDepth: 99
    })
    const projection = terminalProjection(db)
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.parentTerminalHandle).toBe('creator')
    db.db
      .prepare(
        "UPDATE dispatch_contexts SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
      )
      .run(creator.id)
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.parentTerminalHandle).toBe('coordinator')
  } finally {
    db.close()
  }
})

it('updates legacy nesting when a coordinator starts and finishes without a dispatch write', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const legacy = db.createRun({
      objective: 'Legacy work',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    db.db.prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(legacy.id)
    db.createDispatchContext({
      taskId: db.createTask({ runId: legacy.id, spec: 'Legacy worker' }).id,
      assigneeHandle: TERMINAL_WORKER_HANDLE,
      assigneePaneKey: TERMINAL_WORKER_PANE,
      creator: { kind: 'system' },
      maxDepth: 99
    })
    const projection = terminalProjection(db)
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.parentTerminalHandle).toBeUndefined()
    const run = db.createCoordinatorRun({
      spec: 'Legacy coordinator',
      coordinatorHandle: 'coordinator'
    })
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.parentTerminalHandle).toBe('coordinator')
    db.updateCoordinatorRun(run.id, 'completed')
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.parentTerminalHandle).toBeUndefined()
  } finally {
    db.close()
  }
})

it('keeps a cleared chat worker under its coordinator in the keyed attention read', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const successor = testOrcaSessionId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const run = db.createRun({
      objective: 'Cleared worker',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORDINATOR_CHAT
    })
    db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'Chat worker' }).id,
      assigneeHandle: `orca_session_id:${WORKER_CHAT}`,
      creator: { kind: 'system' },
      maxDepth: 99
    })
    const root = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: WORKER_CHAT }))
    root.conversationCommand = {
      command: 'clear',
      runtimeFence: 7,
      operationId: 'clear-worker',
      callerKey: 'renderer',
      phase: 'committed',
      state: 'completed',
      replacementSessionId: successor
    }
    const records = new Map<string, ReturnType<typeof agentSessionConversationView>>([
      [WORKER_CHAT, agentSessionConversationView(root)],
      [
        successor,
        agentSessionConversationView(
          agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: successor }))
        )
      ],
      [
        COORDINATOR_CHAT,
        agentSessionConversationView(
          agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: COORDINATOR_CHAT }))
        )
      ]
    ])
    const projection = new RuntimeAgentOrchestrationProjection({
      getDb: () => db,
      getLeaves: () => [],
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: () => '',
      issuePtyHandle: () => '',
      makePaneKey: () => '',
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getAgentStatusForPaneKey: () => [],
      getSessionRecords: () => ({
        getRecord: (id) => records.get(id) ?? null,
        listRecords: () => [...records.values()],
        listClearedFrom: (id) => (id === successor ? [WORKER_CHAT] : [])
      })
    })
    expect(projection.getForPaneKey(chatRow(successor))?.parentPaneKey).toBe(
      chatRow(COORDINATOR_CHAT)
    )
    expect(projection.getForPaneKey(chatRow(successor))).toEqual(
      projection.buildByPaneKey()?.[chatRow(successor)]
    )
    expect(projection.getForPaneKey(chatRow(WORKER_CHAT))).toBeUndefined()
  } finally {
    db.close()
  }
})

it('reveals an accepted failure after only its sibling worker settles, and retires read guidance', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'Attention changes',
      coordinatorHandle: 'coordinator',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: 'Retrying work' })
    const first = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: TERMINAL_WORKER_HANDLE,
      assigneePaneKey: TERMINAL_WORKER_PANE,
      creator: { kind: 'system' },
      maxDepth: 99
    })
    // A retry shares the task; lifecycle writers can change only its worker row.
    db.db
      .prepare(
        "INSERT INTO dispatch_contexts(id,run_id,task_id,assignee_handle,status) VALUES('retry',?,?,?,'dispatched')"
      )
      .run(run.id, task.id, 'retry-worker')
    db.db.prepare("INSERT INTO worker_dispatches(dispatch_id,state) VALUES('retry','ready')").run()
    db.recordAttemptObservation({
      id: 'accepted-failure',
      dispatchId: first.id,
      sequence: 1,
      authorityId: 'home',
      authorityClock: 'home',
      facet: 'worker_report',
      payload: { status: 'accepted', outcome: 'failed' },
      homeReceivedAt: Date.now()
    })
    const projection = terminalProjection(db)
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.attention?.categories).not.toContain(
      'failure'
    )
    db.db.prepare("UPDATE worker_dispatches SET state='stopped' WHERE dispatch_id='retry'").run()
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.attention?.categories).toContain(
      'failure'
    )
    db.db
      .prepare(
        "INSERT INTO messages(id,run_id,from_handle,to_handle,subject) VALUES('guidance',?,'coordinator',?,'Please check the output')"
      )
      .run(run.id, `dispatch:${first.id}`)
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.attention?.categories).toContain(
      'guidance'
    )
    db.db.prepare("UPDATE messages SET read=1 WHERE id='guidance'").run()
    expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.attention?.categories).not.toContain(
      'guidance'
    )
    expect(projection.buildByPaneKey()?.[TERMINAL_WORKER_PANE]?.attention?.categories).toContain(
      'failure'
    )
  } finally {
    db.close()
  }
})
