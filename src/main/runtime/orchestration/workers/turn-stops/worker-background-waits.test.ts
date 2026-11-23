import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { WorkerBackgroundWaits } from './worker-background-waits'
import { observeWorker, reconsiderWorkerRest } from './worker-presence-report'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'

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

  function notices(): string[] {
    return db.db
      .prepare(`SELECT body FROM messages
          WHERE subject = 'Worker is still waiting on its background task' ORDER BY rowid`)
      .all()
      .map((message) => String(message.body))
  }

  it('is told once, at the bound, and never again for the same wait', () => {
    const orca = startOrca()
    row = heldRow(TURN_END)
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 0 })
    advanceTo(TURN_END + 59 * MINUTE)
    expect(notices()).toEqual([])

    advanceTo(TURN_END + 60 * MINUTE)
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toContain(
      `Worker ${HANDLE} has been waiting on its background task \`./rig/soak.sh 3\` for 60 min`
    )

    // The same wait seen again, live or after a restart that remints the process id, is the same fact.
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 1 })
    const restarted = startOrca('incarnation_after_restart')
    restarted.observe({
      kind: 'seeded',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/w', sshHostId: null },
      phase: 'working',
      at: 2
    })
    restarted.arm(db, dispatchId)
    // A prompt mid-wait, then the same wait again: one fact still.
    row = {
      ...heldRow(TURN_END),
      state: 'waiting',
      workingMode: undefined,
      mainAgent: { state: 'waiting', stateStartedAt: TURN_END + MINUTE }
    }
    // The prompt's own edge records it first; the row moving to the prompt does not end it as working.
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
    row = heldRow(TURN_END)
    restarted.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 5 })
    advanceTo(TURN_END + 120 * MINUTE)
    reconsiderWorkerRest(db, dispatchId, {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {}
    })
    expect(notices()).toHaveLength(1)
  })

  it('stays quiet when a turn starts before the bound', () => {
    const orca = startOrca()
    row = heldRow(TURN_END)
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 0 })
    advanceTo(TURN_END + 30 * MINUTE)
    row = leadWorkingRow(TURN_END + 30 * MINUTE)
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 1 })
    advanceTo(TURN_END + 90 * MINUTE)
    expect(notices()).toEqual([])
  })

  it('stays quiet when the row shows a new turn that no edge reported', () => {
    row = heldRow(TURN_END)
    startOrca().observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: null,
      phase: 'working',
      at: 0
    })
    // Orca was down while a finished task woke the worker: the restored row is already a new turn.
    timers = []
    row = leadWorkingRow(TURN_END + 10 * MINUTE)
    advanceTo(TURN_END + 90 * MINUTE)
    // The restart pass decides undecided rests before the re-armed timer runs.
    reconsiderWorkerRest(db, dispatchId, {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {},
      backgroundWaitShown: () => false
    })
    startOrca().arm(db, dispatchId)
    advanceTo(TURN_END + 91 * MINUTE)
    expect(notices()).toEqual([])
  })

  it('still tells the coordinator when Orca restarts during the wait', () => {
    row = heldRow(TURN_END)
    startOrca().observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: null,
      phase: 'working',
      at: 0
    })
    advanceTo(TURN_END + 20 * MINUTE)
    // The old process's timer died with it.
    timers = []
    startOrca().arm(db, dispatchId)
    advanceTo(TURN_END + 60 * MINUTE)
    expect(notices()).toHaveLength(1)
  })
  it('reports a lead turn that failed under its background task once, across a restart', () => {
    const errors = () =>
      db.db
        .prepare(`SELECT body FROM messages
            WHERE subject = 'Worker stopped on an error without reporting' ORDER BY rowid`)
        .all()
        .map((message) => String(message.body))
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
    // The failure replaced the wait, so no background-wait notice follows it either.
    advanceTo(TURN_END + 120 * MINUTE)
    expect(errors()).toHaveLength(1)
    expect(notices()).toEqual([])
  })
})
