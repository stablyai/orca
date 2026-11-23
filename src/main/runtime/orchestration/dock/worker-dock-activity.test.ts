import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { readWorkerDock } from './worker-dock-read'
import { refreshWorkerDockActivity } from './worker-dock-activity'
import type { FleetSessionObservation } from '../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type * as SessionWorkerLiveness from '../workers/lifecycle/session-worker-liveness'

// The host's verdict on each structured worker's session, as the session-record store would give it.
const sessions = new Map<string, FleetSessionObservation>()
vi.mock('../workers/lifecycle/session-worker-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionWorkerLiveness>()
  return {
    ...actual,
    createSessionWorkerLivenessReader:
      () =>
      (worker: { agentTerminalHandle: string | null }): FleetSessionObservation | undefined =>
        worker.agentTerminalHandle ? sessions.get(worker.agentTerminalHandle) : undefined
  }
})

const source = '11111111-1111-4111-8111-111111111111'
const party = `orca_session_id:${source}`
let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
  sessions.clear()
})

function readyStructuredWorker(handle: string, sessionId: string): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Tidy the release notes' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'claude' }
  })
  db.db
    .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = ? WHERE id = ?')
    .run(source, dispatch.id)
  db.db
    .prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?")
    .run(dispatch.id)
  db.db
    .prepare(
      'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ? WHERE id = ?'
    )
    .run(handle, `pane_${sessionId}`, `structured:${sessionId}`, dispatch.id)
  return dispatch.id
}

// After Orca quits mid-turn, a structured worker's chat has no provider child and no status row.
const runtime: Parameters<typeof refreshWorkerDockActivity>[2] = {
  readAgentStatusOfPanes: () => [],
  readObservedAgentStatusPaneIdentityFn: () => ({ kind: 'unobserved' }),
  getAgentStatusTerminalHandleForPaneKey: () => undefined,
  getTerminalProcessIncarnation: () => null
}

describe('worker dock activity verdict', () => {
  it('shows a worker whose session exited as stopped, not as unavailable, and keeps Stop', () => {
    const exited = readyStructuredWorker('structworker_exited', 'session-exited')
    const unknown = readyStructuredWorker('structworker_unknown', 'session-unknown')
    sessions.set('structworker_exited', { status: 'exited' })
    sessions.set('structworker_unknown', {
      status: 'unverifiable',
      detail: 'The session runs on another host.'
    })

    refreshWorkerDockActivity(db, party, runtime)
    const rows = readWorkerDock(db, { party, direction: 'around', currentOnly: true }).rows

    expect(rows.find((row) => row.dispatchId === exited)).toMatchObject({
      state: 'unexpected',
      // Its dispatch is still open: Stop settles it, and there is nothing to clear yet.
      stoppable: true,
      settlement: null
    })
    // Only a session Orca cannot observe stays unavailable.
    expect(rows.find((row) => row.dispatchId === unknown)?.state).toBe('unavailable')
  })
})
