import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { WorkerBackgroundWaits } from './worker-background-waits'
import { reconsiderWorkerRest } from './worker-presence-report'

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
  function startOrca(): WorkerBackgroundWaits {
    return new WorkerBackgroundWaits({
      getDb: () => db,
      isWaitingForMail: () => false,
      notify: () => {},
      readHookRow: () => row,
      getHandle: () => HANDLE,
      getProcessIncarnation: () => 'incarnation_1',
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
      .prepare(`SELECT body FROM messages WHERE type = 'escalation' ORDER BY rowid`)
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

    // The same wait seen again, live or after a restart, is the same fact.
    orca.observe({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'working', at: 1 })
    const restarted = startOrca()
    restarted.observe({
      kind: 'seeded',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/w', sshHostId: null },
      phase: 'working',
      at: 2
    })
    restarted.arm(db, dispatchId)
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
})
