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
    completeTurn(reporter, 'turn-user')
    expect(stopEscalations()).toEqual([])

    // Second coordinator message answered via threaded reply (orca orchestration reply / --thread-id).
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

    const second = sendCoordinatorMail('question 2')
    // Threaded mail addressed to a non-coordinator peer does not answer the coordinator.
    db.insertMessage({
      from: WORKER_ADDRESS,
      senderDispatchId: dispatchId,
      to: 'term_sibling',
      subject: 'Peer note',
      body: 'Not sent to coordinator',
      type: 'status',
      threadId: second.id,
      runId
    })
    completeTurn(reporter, 'turn-second-silent')
    expect(stopEscalations()).toEqual(['Worker stopped without reporting'])
  })

  it('still escalates when coordinator mail is consumed out of order and an older message becomes read during the quiet window', () => {
    const reporter = createReporter()

    // Insert `skipped` before `first` and leave it unread until the quiet window so a count-based
    // slice(0, mailTaken) lookup would mistakenly select the already-answered `first`.
    const skipped = db.insertMessage({
      from: COORDINATOR_ADDRESS,
      to: `dispatch:${dispatchId}`,
      subject: 'skipped for now',
      body: 'Unread earlier sequence',
      type: 'status',
      runId
    })
    const first = sendCoordinatorMail('first')
    db.insertMessage({
      from: WORKER_ADDRESS,
      senderDispatchId: dispatchId,
      to: `run:${runId}`,
      subject: `Re: ${first.subject}`,
      body: 'Answered first.',
      type: 'status',
      threadId: first.id,
      runId
    })
    completeTurn(reporter, 'turn-1')
    expect(stopEscalations()).toEqual([])

    const third = sendCoordinatorMail('third consumed first')

    // Turn ends without answering `third`; before the quiet timer fires, `skipped` is marked read.
    reporter.onTurnAttention(
      {
        type: 'completion',
        completion: {
          scope: SESSION_SCOPE,
          sessionId: WORKER_SESSION,
          turnId: 'turn-out-of-order',
          outcome: 'success',
          completedAt: clock
        }
      },
      () => ({ status: 'idle', lastAssistantMessage: 'Done.' })
    )
    expect(first.sequence).toBeGreaterThan(skipped.sequence)
    expect(third.sequence).toBeGreaterThan(first.sequence)
    db.markAsRead([skipped.id], { kind: 'session', sessionId: WORKER_SESSION })
    flushTimers()
    expect(stopEscalations()).toEqual(['Worker stopped without reporting'])
  })

  it('does not count a prior turn status when turn start is unknown or within the same second', () => {
    db.insertMessage({
      from: WORKER_ADDRESS,
      senderDispatchId: dispatchId,
      to: `run:${runId}`,
      subject: 'Earlier turn status',
      body: 'Sent in a prior turn before restart',
      type: 'status',
      runId
    })

    // First observed turn on a fresh reporter has unknown turn start and no consumed mail.
    const reporter = createReporter()
    completeTurn(reporter, 'turn-unknown-start')
    expect(stopEscalations()).toEqual(['Worker stopped without reporting'])

    // On a fresh open Dispatch with no consumed mail, a cancelled turn at .900s that sent a status
    // must not suppress the next silent turn in the exact same second (.950s).
    const secondSession = createOrcaSessionId(() => '33333333-3333-4333-8333-333333333333')
    const secondWorkerAddress = formatOrcaSessionAddress(secondSession)
    const secondTaskId = db.createTask({ spec: 'same-second sequence watermark', runId }).id
    const secondDispatchId = db.createDispatchContext({
      taskId: secondTaskId,
      assigneeHandle: secondWorkerAddress,
      creator: { kind: 'session', orcaSessionId: COORDINATOR_SESSION },
      maxDepth: Number.MAX_SAFE_INTEGER
    }).id
    clock = Date.UTC(2026, 10, 25, 18, 0, 0, 100)
    observeChatWorkerWorking(secondSession, {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {}
    })
    db.insertMessage({
      from: secondWorkerAddress,
      senderDispatchId: secondDispatchId,
      to: `run:${runId}`,
      subject: 'Cancelled turn status',
      body: 'Sent before cancellation in same second',
      type: 'status',
      runId
    })
    clock = Date.UTC(2026, 10, 25, 18, 0, 0, 900)
    reporter.onTurnAttention(
      {
        type: 'completion',
        completion: {
          scope: SESSION_SCOPE,
          sessionId: secondSession,
          turnId: 'turn-cancelled-same-sec',
          outcome: 'cancellation',
          completedAt: clock
        }
      },
      () => ({ status: 'idle', lastAssistantMessage: '' })
    )
    clock = Date.UTC(2026, 10, 25, 18, 0, 0, 950)
    reporter.onTurnAttention(
      {
        type: 'completion',
        completion: {
          scope: SESSION_SCOPE,
          sessionId: secondSession,
          turnId: 'turn-silent-same-sec',
          outcome: 'success',
          completedAt: clock
        }
      },
      () => ({ status: 'idle', lastAssistantMessage: 'Done.' })
    )
    flushTimers()
    expect(stopEscalations()).toEqual([
      'Worker stopped without reporting',
      'Worker stopped without reporting'
    ])

    // A valid report sent in the new turn within the same second (.980s) still suppresses escalation.
    const mail = db.insertMessage({
      from: COORDINATOR_ADDRESS,
      to: `dispatch:${secondDispatchId}`,
      subject: 'same-second follow-up',
      body: 'Check status',
      type: 'status',
      runId
    })
    db.markAsRead([mail.id], { kind: 'session', sessionId: secondSession })
    clock = Date.UTC(2026, 10, 25, 18, 0, 0, 980)
    db.insertMessage({
      from: secondWorkerAddress,
      senderDispatchId: secondDispatchId,
      to: `run:${runId}`,
      subject: 'Same-second valid status',
      body: 'Sent after turn boundary in same second',
      type: 'status',
      runId
    })
    reporter.onTurnAttention(
      {
        type: 'completion',
        completion: {
          scope: SESSION_SCOPE,
          sessionId: secondSession,
          turnId: 'turn-reported-same-sec',
          outcome: 'success',
          completedAt: clock
        }
      },
      () => ({ status: 'idle', lastAssistantMessage: 'Done.' })
    )
    flushTimers()
    expect(stopEscalations()).toHaveLength(2)
  })

  it('does not treat an earlier remote reply on the same thread as answering a newer coordinator message', () => {
    const remoteTarget = {
      kind: 'remote' as const,
      attachment: { dispatch_id: 'dsp_remote', task_id: 'task_remote' }
    }
    const deps = { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }

    const first = db.insertMessage({
      from: COORDINATOR_ADDRESS,
      to: 'dispatch:dsp_remote',
      subject: 'remote q1',
      body: 'First question',
      type: 'status',
      threadId: 'thread_shared',
      runId
    })
    db.markAsRead([first.id], { kind: 'terminal', handle: 'term_remote' })
    const earlyReply = db.enqueueFederationRelay({
      dispatchId: 'dsp_remote',
      direction: 'to_home',
      kind: 'status',
      payload: JSON.stringify({
        from: 'term_remote',
        subject: 'Re: remote q1',
        body: 'First answer',
        type: 'status',
        threadId: 'thread_shared'
      })
    })
    db.db
      .prepare(
        "UPDATE federation_relay_items SET created_at = datetime('now', '-10 seconds') WHERE dispatch_id = ? AND sequence = ?"
      )
      .run('dsp_remote', earlyReply.sequence)

    const second = db.insertMessage({
      from: COORDINATOR_ADDRESS,
      to: 'dispatch:dsp_remote',
      subject: 'remote q2',
      body: 'Follow-up on same thread',
      type: 'status',
      threadId: 'thread_shared',
      runId
    })
    db.markAsRead([second.id], { kind: 'terminal', handle: 'term_remote' })

    expect(
      observeWorker(
        db,
        remoteTarget,
        {
          presence: 'at-rest',
          fence: 'remote-turn-2',
          legacyStopKey: 'remote-turn-2',
          rest: {
            from: 'term_remote',
            reason: 'finished',
            mailTaken: 2,
            latestCoordinatorSequence: second.sequence,
            lastOutput: 'Silent stop'
          }
        },
        deps
      )
    ).toBe(true)
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
