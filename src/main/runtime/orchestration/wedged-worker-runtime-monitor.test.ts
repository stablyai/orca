import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { WorkerPaneSample } from './worker-progress-evidence'
import {
  ensureWedgedWorkerMonitor,
  runWedgedWorkerScan,
  stopWedgedWorkerMonitor
} from './wedged-worker-runtime-monitor'

const MINUTE = 60_000
const WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const WORKER_INCARNATION = 'pty_worker:incarnation_1'

// Why a proxy: the acceptance bar is that nothing in this path stops, kills, restarts,
// closes, focuses or writes to a terminal. Any runtime call outside this allowlist fails.
const ALLOWED_RUNTIME_CALLS = new Set([
  'getOrchestrationDb',
  'getOrchestrationWorkerPaneActivity',
  'hasOrchestrationMailboxWaiter',
  'notifyMessageArrived'
])

type RuntimeStub = {
  runtime: OrcaRuntimeService
  calls: string[]
  notified: { handle: string; type?: string }[]
}

describe('wedged worker runtime monitor', () => {
  let db: OrchestrationDb
  let stub: RuntimeStub
  let paneSample: WorkerPaneSample | null

  function createRuntimeStub(): RuntimeStub {
    const calls: string[] = []
    const notified: { handle: string; type?: string }[] = []
    const target = {
      getOrchestrationDb: () => db,
      getOrchestrationWorkerPaneActivity: () => paneSample,
      hasOrchestrationMailboxWaiter: () => false,
      notifyMessageArrived: (handle: string, type?: string) => {
        notified.push({ handle, type })
      }
    }
    const runtime = new Proxy(target, {
      get(source, property, receiver) {
        const name = String(property)
        if (!ALLOWED_RUNTIME_CALLS.has(name)) {
          throw new Error(`wedged-worker detection must not touch runtime.${name}`)
        }
        calls.push(name)
        return Reflect.get(source, property, receiver)
      }
    }) as unknown as OrcaRuntimeService
    return { runtime, calls, notified }
  }

  function startReadyWorker(runId: string): { dispatchId: string; taskId: string } {
    const task = db.createTask({ spec: 'implement the thing', runId })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'claude' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: WORKER_INCARNATION,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { dispatchId: started.dispatch.id, taskId: task.id }
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    stub = createRuntimeStub()
    paneSample = {
      connected: true,
      processIncarnation: WORKER_INCARNATION,
      lastOutputAtEpochMs: Date.now(),
      agentState: 'working',
      agentEventAtEpochMs: Date.now(),
      agentTurnStartedAtEpochMs: Date.now()
    }
  })

  afterEach(() => {
    stopWedgedWorkerMonitor(stub.runtime)
    vi.useRealTimers()
    db.close()
  })

  it('publishes one escalation into the Run mailbox and wakes the coordinator', () => {
    const run = db.createRun({
      objective: 'ship the feature',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:22222222-2222-4222-8222-222222222222'
    })
    const { dispatchId } = startReadyWorker(run.id)
    const quietSince = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(quietSince + 40 * MINUTE)
    paneSample = { ...(paneSample as WorkerPaneSample), lastOutputAtEpochMs: quietSince }

    ensureWedgedWorkerMonitor(stub.runtime)
    expect(runWedgedWorkerScan(stub.runtime)).toMatchObject({ candidates: 1, escalated: 1 })

    const mailbox = db.getUnreadMessages(`run:${run.id}`, ['escalation'])
    expect(mailbox).toHaveLength(1)
    expect(mailbox[0]).toMatchObject({
      from_handle: `dispatch:${dispatchId}`,
      to_handle: `run:${run.id}`,
      type: 'escalation',
      priority: 'high'
    })
    expect(stub.notified).toEqual([{ handle: `run:${run.id}`, type: 'escalation' }])
    // A second scan at the short interval stays silent.
    expect(runWedgedWorkerScan(stub.runtime)).toMatchObject({ escalated: 0 })
    expect(db.getUnreadMessages(`run:${run.id}`, ['escalation'])).toHaveLength(1)
  })

  it('stops itself when no supervised worker is left to watch', () => {
    ensureWedgedWorkerMonitor(stub.runtime)
    expect(runWedgedWorkerScan(stub.runtime)).toMatchObject({ candidates: 0, escalated: 0 })
    expect(runWedgedWorkerScan(stub.runtime)).toBeNull()
  })

  it('arms at most one monitor per runtime', () => {
    ensureWedgedWorkerMonitor(stub.runtime)
    ensureWedgedWorkerMonitor(stub.runtime)
    stopWedgedWorkerMonitor(stub.runtime)
    expect(runWedgedWorkerScan(stub.runtime)).toBeNull()
  })
})
