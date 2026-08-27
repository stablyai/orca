import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { runLivenessSweep, type LivenessSignalSource } from './liveness-sweep'

/** TERMINAL_OUTPUT_LIVENESS_BOUND_TO_THE_HANDLE — activity evidence read the
 *  terminal HANDLE, which outlives the process bound to it, and applied no
 *  dispatch-start floor. Output from whatever occupies the pane now — a user
 *  typing, or a reused pane — read as the dispatched worker still working, so a
 *  hung worker never reached `stalled`.
 */
describe('TERMINAL_OUTPUT_LIVENESS_BOUND_TO_THE_HANDLE', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const nowMs = Date.parse('2026-01-01T12:00:00.000Z')
  // The Dispatch itself started two hours ago, so its own start stamp is well
  // outside the stall window and cannot stand in for observed activity.
  const dispatchedAt = '2026-01-01 10:00:00'
  const beforeTheDispatch = Date.parse('2026-01-01T09:00:00.000Z')

  function world() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'ship',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'pane_c:leaf'
    })
    const task = db.createTask({ spec: 'work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'claude' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'term_worker:leaf',
      processIncarnation: 'pty_1:inc_1',
      launchTokenHash: 'hash',
      worktreeId: 'repo::/tmp/x',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    db.db
      .prepare(`UPDATE dispatch_contexts SET created_at = ?, dispatched_at = ? WHERE id = ?`)
      .run(dispatchedAt, dispatchedAt, started.dispatch.id)
    return { runId: run.id, dispatchId: started.dispatch.id }
  }

  function source(lastOutput: (incarnation: string | null) => number | null): LivenessSignalSource {
    return {
      agentStatusSnapshot: () => [],
      inspectProcessLiveness: async () => 'live',
      approvedWaitUntil: () => null,
      lastTerminalOutputAtMs: (_handle, incarnation) => lastOutput(incarnation)
    }
  }

  async function activityOf(
    runId: string,
    dispatchId: string,
    lastOutput: (incarnation: string | null) => number | null
  ) {
    await runLivenessSweep({ db: db!, runId, source: source(lastOutput), nowMs })
    const marker = new ControlPlaneStore(db!).getLivenessMarker(dispatchId)
    return { verdict: marker?.verdict, activity: marker?.activity }
  }

  it('stalls a hung worker whose pane is producing output under another incarnation', async () => {
    const { runId, dispatchId } = world()
    // The runtime answers only for the incarnation it is asked about, so output
    // from a pane rebound to pty_2 is not evidence about THIS dispatch. Reading
    // the handle alone reported it as working indefinitely.
    expect(
      await activityOf(runId, dispatchId, (inc) => (inc === 'pty_2:inc_2' ? nowMs : null))
    ).toMatchObject({ activity: 'stalled' })
  })

  it('negative control: fresh output on the dispatch own incarnation is live', async () => {
    const { runId, dispatchId } = world()
    expect(
      await activityOf(runId, dispatchId, (inc) => (inc === 'pty_1:inc_1' ? nowMs : null))
    ).toMatchObject({ verdict: 'live', activity: 'working' })
  })

  it('ignores output older than the Dispatch itself', async () => {
    const { runId, dispatchId } = world()
    // Output predating the Dispatch cannot be evidence about it, whoever wrote it.
    expect(await activityOf(runId, dispatchId, () => beforeTheDispatch)).toMatchObject({
      activity: 'stalled'
    })
  })
})
