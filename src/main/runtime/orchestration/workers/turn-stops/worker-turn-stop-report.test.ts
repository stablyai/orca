import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createOrcaSessionId,
  formatOrcaSessionAddress
} from '../../../../../shared/agent-session/identity/orca-session-address'
import type { AgentSessionExecutionLocation } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { chatWorkerTurnStopReporter, observeChatWorkerWorking } from './chat-worker-turn-stops'
import { observeWorker } from './worker-presence-report'
import { approvalReportId, reportWorkerApprovalClosed } from './worker-turn-stop-report'

const WORKER_SESSION = createOrcaSessionId(() => '11111111-1111-4111-8111-111111111111')
const COORDINATOR_SESSION = createOrcaSessionId(() => '22222222-2222-4222-8222-222222222222')
const WORKER_ADDRESS = formatOrcaSessionAddress(WORKER_SESSION)
const COORDINATOR_ADDRESS = formatOrcaSessionAddress(COORDINATOR_SESSION)
const SESSION_SCOPE: AgentSessionExecutionLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: 'repo::/w',
  workspaceKind: 'git-worktree'
}

describe('post-reply idle-stop dedupe for open chat workers', () => {
  let db: OrchestrationDb
  let runId: string
  let taskId: string
  let dispatchId: string
  let clock: number
  let pendingTimers: (() => void)[]

  beforeEach(() => {
    clock = Date.UTC(2026, 10, 25, 18, 0, 0)
    pendingTimers = []
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'open chat worker follow-ups',
      coordinatorHandle: COORDINATOR_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORDINATOR_SESSION
    })
    runId = run.id
    taskId = db.createTask({ spec: 'investigate and stay open for follow-ups', runId }).id
    dispatchId = db.createDispatchContext({
      taskId,
      assigneeHandle: WORKER_ADDRESS,
      creator: {
        kind: 'session',
        orcaSessionId: COORDINATOR_SESSION
      },
      maxDepth: Number.MAX_SAFE_INTEGER
    }).id
  })

  afterEach(() => {
    db.close()
  })

  function flushTimers(): void {
    for (const run of pendingTimers.splice(0)) {
      run()
    }
  }

  function createReporter() {
    return chatWorkerTurnStopReporter(
      {
        getDb: () => db,
        isWaitingForMail: () => false,
        notify: () => {}
      },
      (run) => {
        pendingTimers.push(run)
        return () => {
          const idx = pendingTimers.indexOf(run)
          if (idx !== -1) {
            pendingTimers.splice(idx, 1)
          }
        }
      },
      async () => null,
      undefined,
      () => clock
    )
  }

  function completeTurn(reporter: ReturnType<typeof createReporter>, turnId: string): void {
    reporter.onTurnAttention(
      {
        type: 'completion',
        completion: {
          scope: SESSION_SCOPE,
          sessionId: WORKER_SESSION,
          turnId,
          outcome: 'success',
          completedAt: clock
        }
      },
      () => ({ status: 'idle', lastAssistantMessage: 'Done.' })
    )
    flushTimers()
  }

  function sendCoordinatorMail(subject: string) {
    const mail = db.insertMessage({
      from: COORDINATOR_ADDRESS,
      to: `dispatch:${dispatchId}`,
      subject,
      body: `Please check ${subject}`,
      type: 'status',
      runId
    })
    db.markAsRead([mail.id], { kind: 'session', sessionId: WORKER_SESSION })
    return mail
  }

  function stopEscalations(): string[] {
    return db.db
      .prepare(
        `SELECT subject FROM messages
          WHERE to_handle = ? AND subject = 'Worker stopped without reporting'
          ORDER BY sequence ASC`
      )
      .all(`run:${runId}`)
      .map((row) => String(row.subject))
  }

  it('stays quiet when an open chat worker consumes coordinator mail, replies or sends outbound status, and finishes cleanly', () => {
    const reporter = createReporter()

    // First coordinator message answered via outbound status to the Run mailbox.
    sendCoordinatorMail('step 1')
    observeChatWorkerWorking(WORKER_SESSION, {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {}
    })
    db.insertMessage({
      from: WORKER_ADDRESS,
      senderDispatchId: dispatchId,
      to: `run:${runId}`,
      subject: 'Step 1 findings',
      body: 'Found the root cause; keeping Dispatch open for follow-up.',
      type: 'status',
      runId
    })
    completeTurn(reporter, 'turn-1')
    expect(stopEscalations()).toEqual([])

    // A later user chat turn with no new coordinator mail stays quiet too.
    clock += 5_000
    completeTurn(reporter, 'turn-user')
    expect(stopEscalations()).toEqual([])

    // Second coordinator message answered via threaded reply (orca orchestration reply / --thread-id).
    clock += 5_000
    const followUp = sendCoordinatorMail('step 2')
    db.insertMessage({
      from: `dispatch:${dispatchId}`,
      to: COORDINATOR_ADDRESS,
      subject: `Re: ${followUp.subject}`,
      body: 'Verified step 2 as well.',
      type: 'status',
      threadId: followUp.id,
      payload: JSON.stringify({ requestId: followUp.id }),
      runId
    })
    completeTurn(reporter, 'turn-2')
    expect(stopEscalations()).toEqual([])
  })

  it('still escalates when an open chat worker consumes coordinator mail and finishes without sending an outbound reply', () => {
    const reporter = createReporter()
    sendCoordinatorMail('silent turn')

    // System-authored approval notices and worker heartbeats do not count as an outbound report.
    const dispatch = db.getDispatchContextById(dispatchId)!
    db.insertMessage({
      id: approvalReportId(dispatchId, 'prompt-1'),
      from: WORKER_ADDRESS,
      senderDispatchId: dispatchId,
      to: `run:${runId}`,
      subject: 'Worker is waiting for permission',
      body: 'Permission prompt',
      type: 'escalation',
      runId
    })
    reportWorkerApprovalClosed(
      db,
      dispatch,
      {
        from: WORKER_ADDRESS,
        approval: {
          v: 1,
          approvalId: 'prompt-1',
          state: 'answered',
          worker: { handle: WORKER_ADDRESS, dispatchId, taskId },
          allowedActions: [],
          summary: { title: 'Run check', detail: null, reason: null },
          outcome: { decision: 'allow', by: 'person', reason: null, reasonDelivered: false }
        }
      },
      { notify: () => {} }
    )
    db.insertMessage({
      from: WORKER_ADDRESS,
      to: `run:${runId}`,
      subject: 'heartbeat',
      type: 'heartbeat',
      runId
    })

    completeTurn(reporter, 'turn-silent')
    expect(stopEscalations()).toEqual(['Worker stopped without reporting'])
  })

  it('still escalates when the worker replies to the first coordinator mail, then finishes a second coordinator mail without replying', () => {
    const reporter = createReporter()

    const first = sendCoordinatorMail('question 1')
    db.insertMessage({
      from: WORKER_ADDRESS,
      senderDispatchId: dispatchId,
      to: `run:${runId}`,
      subject: 'Re: question 1',
      body: 'Answered first mail.',
      type: 'status',
      threadId: first.id,
      runId
    })
    completeTurn(reporter, 'turn-first')
    expect(stopEscalations()).toEqual([])

    clock += 10_000
    sendCoordinatorMail('question 2')
    completeTurn(reporter, 'turn-second-silent')
    expect(stopEscalations()).toEqual(['Worker stopped without reporting'])
  })

  it('still escalates errored, needs-input, and exited stops even after an outbound status message', () => {
    sendCoordinatorMail('work item')
    db.insertMessage({
      from: WORKER_ADDRESS,
      senderDispatchId: dispatchId,
      to: `run:${runId}`,
      subject: 'Progress note',
      body: 'Starting check',
      type: 'status',
      runId
    })
    const target = { kind: 'local' as const, dispatch: db.getDispatchContextById(dispatchId)! }
    const deps = { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }

    expect(
      observeWorker(
        db,
        target,
        {
          presence: 'at-rest',
          fence: 'err:1',
          legacyStopKey: 'err:1',
          rest: { from: WORKER_ADDRESS, reason: 'errored', lastOutput: 'Boom' }
        },
        deps
      )
    ).toBe(true)
    expect(
      observeWorker(
        db,
        target,
        {
          presence: 'at-rest',
          fence: 'prompt:1',
          legacyStopKey: 'prompt:1',
          rest: { from: WORKER_ADDRESS, reason: 'needs-input', awaitsReply: true, lastOutput: '?' }
        },
        deps
      )
    ).toBe(true)
    expect(
      observeWorker(
        db,
        target,
        {
          presence: 'gone',
          fence: 'exit:1',
          legacyStopKey: 'exit:1',
          gone: { from: WORKER_ADDRESS, reason: 'exited', cause: 'crashed', lastOutput: undefined }
        },
        deps
      )
    ).toBe(true)

    const subjects = db.db
      .prepare(
        `SELECT subject FROM messages
          WHERE to_handle = ? AND type = 'escalation' ORDER BY sequence ASC`
      )
      .all(`run:${runId}`)
      .map((row) => String(row.subject))
    expect(subjects).toEqual([
      'Worker stopped on an error without reporting',
      'Worker is waiting on a prompt',
      'Worker exited without reporting'
    ])
  })
})
