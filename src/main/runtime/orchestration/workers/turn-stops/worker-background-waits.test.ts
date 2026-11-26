import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { sessionWorkerAgentState } from '../../../../../shared/orchestration-session-workers'
import { sessionWorkerBackgroundWait } from '../../../rpc/methods/orchestration/worker/session-worker-background-wait'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { WorkerBackgroundWaits } from './worker-background-waits'
import { observeWorker, reconsiderWorkerRest } from './worker-presence-report'

const PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const HANDLE = 'term_worker'
const MINUTE = 60_000
const TURN_END = Date.UTC(2026, 10, 22, 6, 31)

type Timer = { at: number; run: () => void; cancelled: boolean }

function heldRow(since: number): AgentStatusIpcPayload {
  return {
    paneKey: PANE,
    tabId: 'tab_worker',
    worktreeId: 'repo::/w',
    connectionId: null,
    receivedAt: since,
    stateStartedAt: since - MINUTE,
    state: 'working',
    workingMode: 'monitoring',
    prompt: '',
    agentType: 'claude',
    backgroundCommands: ['./rig/soak.sh 3'],
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: since }
  }
}

function leadWorkingRow(at: number): AgentStatusIpcPayload {
  return {
    ...heldRow(at),
    workingMode: undefined,
    backgroundCommands: undefined,
    mainAgent: { state: 'working', stateStartedAt: at }
  }
}

describe('a worker waiting on its own background task', () => {
  let db: OrchestrationDb
  let dispatchId: string
  let runId: string
  let timers: Timer[]
  let row: AgentStatusIpcPayload | null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TURN_END)
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'bg',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: `tab_c:${PANE.split(':')[1]}`
    })
    runId = run.id
    const task = db.createTask({ spec: 'run the soak', runId: run.id })
    dispatchId = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: HANDLE,
      assigneePaneKey: PANE,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    }).id
    timers = []
    row = null
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  // One Orca process: a restart is a new one over the same database.
  function startOrca(incarnation = 'incarnation_1'): WorkerBackgroundWaits {
    return new WorkerBackgroundWaits({
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {},
      readHookRow: () => row,
      getHandle: () => HANDLE,
      getProcessIncarnation: () => incarnation,
      setTimer: (run, delayMs) => {
        const timer = { at: Date.now() + delayMs, run, cancelled: false }
        timers.push(timer)
        return { cancel: () => (timer.cancelled = true) }
      }
    })
  }

  function advanceTo(at: number): void {
    vi.setSystemTime(at)
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) {
        continue
      }
      if (timer.at <= at) {
        timer.run()
      } else {
        timers.push(timer)
      }
    }
  }

  function escalations(): { subject: string; body: string }[] {
    return db.db
      .prepare(
        `SELECT subject, body FROM messages
          WHERE to_handle = ? AND type = 'escalation' ORDER BY rowid`
      )
      .all(`run:${runId}`)
      .map((message) => ({ subject: String(message.subject), body: String(message.body) }))
  }

  it('records passive background-wait presence and view activity without waking the coordinator while the child task runs', () => {
    const orca = startOrca()
    row = heldRow(TURN_END)
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 0 })

    const initialPresence = readWorkerPresence(db, dispatchId)
    expect(initialPresence).toMatchObject({
      presence: 'resting',
      fence: `background:${TURN_END}`
    })
    expect(JSON.parse(initialPresence?.report ?? '{}')).toMatchObject({
      reason: 'background-wait',
      backgroundWait: { since: TURN_END, commands: ['./rig/soak.sh 3'], paneKey: PANE }
    })

    const projectedWait = sessionWorkerBackgroundWait(
      {
        stage: {
          worker: 'ready',
          dispatch: 'dispatched',
          detail: 'running',
          activity: 'working',
          backgroundWait: { since: TURN_END, commands: ['./rig/soak.sh 3'] }
        }
      },
      'working',
      null,
      new Map()
    )
    expect(projectedWait).toEqual({
      backgroundWait: { since: TURN_END, commands: ['./rig/soak.sh 3'] }
    })
    expect(
      sessionWorkerAgentState({
        activity: 'working',
        ...projectedWait
      })
    ).toBe('done')

    // Past 20 min and 120 min, and across a restart, a live child task never wakes the coordinator.
    advanceTo(TURN_END + 20 * MINUTE)
    expect(escalations()).toEqual([])

    const restarted = startOrca('incarnation_after_restart')
    restarted.observe({
      kind: 'seeded',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/w', sshHostId: null },
      phase: 'working',
      at: 2
    })
    restarted.arm(db, dispatchId)
    reconsiderWorkerRest(db, dispatchId, {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {}
    })
    expect(escalations()).toEqual([])

    // An interactive prompt mid-wait still escalates immediately, then returning to the wait stays quiet.
    row = {
      ...heldRow(TURN_END),
      state: 'waiting',
      workingMode: undefined,
      mainAgent: { state: 'waiting', stateStartedAt: TURN_END + 21 * MINUTE }
    }
    observeWorker(
      db,
      { kind: 'local', dispatch: db.getDispatchContextById(dispatchId)! },
      {
        presence: 'at-rest',
        fence: 'prompt:1',
        legacyStopKey: 'prompt:1',
        rest: { from: HANDLE, reason: 'needs-input', lastOutput: undefined }
      },
      { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }
    )
    restarted.observe({
      kind: 'moved',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/w', sshHostId: null },
      from: 'working',
      to: 'needs-you',
      at: 3,
      transition: null
    })
    expect(readWorkerPresence(db, dispatchId)?.presence).toBe('prompt')
    expect(escalations().map((m) => m.subject)).toEqual(['Worker is waiting on a prompt'])

    row = heldRow(TURN_END)
    restarted.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 5 })
    advanceTo(TURN_END + 120 * MINUTE)
    reconsiderWorkerRest(db, dispatchId, {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {}
    })
    expect(readWorkerPresence(db, dispatchId)).toMatchObject({
      presence: 'resting',
      fence: `background:${TURN_END}`
    })
    expect(escalations().map((m) => m.subject)).toEqual(['Worker is waiting on a prompt'])
  })

  it('clears the recorded wait across a restart when the row already moved to a new turn', () => {
    row = heldRow(TURN_END)
    startOrca().observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: null,
      phase: 'working',
      at: 0
    })
    row = leadWorkingRow(TURN_END + 10 * MINUTE)
    advanceTo(TURN_END + 90 * MINUTE)
    startOrca('incarnation_after_restart').arm(db, dispatchId)
    expect(readWorkerPresence(db, dispatchId)?.report).toBeNull()
    expect(escalations()).toEqual([])
  })

  it('escalates immediately when the worker process exits during a background wait', () => {
    const orca = startOrca()
    row = heldRow(TURN_END)
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 0 })
    expect(escalations()).toEqual([])

    observeWorker(
      db,
      { kind: 'local', dispatch: db.getDispatchContextById(dispatchId)! },
      {
        presence: 'gone',
        fence: 'exit:1',
        legacyStopKey: 'exit:1',
        gone: { from: HANDLE, reason: 'exited', cause: 'exit code 137', lastOutput: 'Killed' }
      },
      { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }
    )
    expect(readWorkerPresence(db, dispatchId)?.presence).toBe('gone')
    expect(escalations().map((m) => m.subject)).toEqual(['Worker exited without reporting'])
  })

  it('reports a lead turn that failed under its background task once, across a restart', () => {
    const errors = () =>
      escalations()
        .filter((m) => m.subject === 'Worker stopped on an error without reporting')
        .map((m) => m.body)
    const orca = startOrca()
    row = heldRow(TURN_END)
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 0 })
    const failedAt = TURN_END + 10 * MINUTE
    // The task's notification woke the lead and its request failed; another task keeps the pane working.
    row = {
      ...heldRow(failedAt),
      lastAssistantMessage: 'API Error: 503 All accounts are temporarily unavailable.',
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: failedAt }
    }
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 1 })
    expect(errors()).toHaveLength(1)
    expect(errors()[0]).toContain(`Worker ${HANDLE} ended its turn on an error without sending`)
    expect(errors()[0]).toContain('API Error: 503')

    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 2 })
    // A restart remints the process id and its sweep reads the same restored row.
    const restarted = startOrca('incarnation_after_restart')
    restarted.observe({
      kind: 'seeded',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/w', sshHostId: null },
      phase: 'working',
      at: 3
    })
    expect(restarted.reportFailedLeadTurn(PANE)).toBe(true)
    // A prompt in between, then the all-clear of the same failed turn, report it under the same fence.
    const target = { kind: 'local' as const, dispatch: db.getDispatchContextById(dispatchId)! }
    const reportDeps = { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }
    observeWorker(
      db,
      target,
      {
        presence: 'at-rest',
        fence: 'prompt:1',
        legacyStopKey: 'prompt:1',
        rest: { from: HANDLE, reason: 'needs-input', lastOutput: undefined }
      },
      reportDeps
    )
    observeWorker(
      db,
      target,
      {
        presence: 'at-rest',
        fence: `failed-lead:${failedAt}`,
        legacyStopKey: 'all-clear',
        rest: { from: HANDLE, reason: 'errored', lastOutput: 'API Error: 503' }
      },
      reportDeps
    )
    advanceTo(TURN_END + 120 * MINUTE)
    expect(errors()).toHaveLength(1)
    expect(
      escalations().filter((m) => m.subject === 'Worker is still waiting on its background task')
    ).toEqual([])

    // The lead's next turn, still under the live task, is work again.
    row = leadWorkingRow(TURN_END + 121 * MINUTE)
    restarted.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 4 })
    expect(readWorkerPresence(db, dispatchId)?.presence).toBe('working')
  })
})
