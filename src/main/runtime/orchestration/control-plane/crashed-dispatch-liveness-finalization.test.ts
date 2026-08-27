import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { readLivenessMarker } from './dispatch-liveness'
import { runLivenessSweep, type LivenessSignalSource } from './liveness-sweep'

/** CRASHED_DISPATCH_STALE_LIVE_MARKER — observed on candidate runtime
 *  `01cc5470-8d99-4afa-a81b-bacc7aab1c66`, Run `run_4aa6b0d8414d`,
 *  Dispatch `ctx_2fb05d5fcd6c`: the worker PTY was killed, the runtime
 *  correctly moved the worker to `failed` / `process_exited`, and
 *  `orchestration state` still answered `verdict: live, activity: working,
 *  reason: "Worker produced output within the stall window."`
 *
 *  Cause: the sweep only visited ACTIVE Dispatches, so one that died between
 *  two sweeps left the set before anything could finalize its marker. The last
 *  non-terminal verdict then stood until the TTL — a false `live` for a dead
 *  worker, which is precisely what the marker contract forbids.
 */
describe('CRASHED_DISPATCH_STALE_LIVE_MARKER', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const NOW = Date.parse('2026-08-27T17:30:00Z')

  function liveSource(processLiveness: 'live' | 'exited'): LivenessSignalSource {
    return {
      agentStatusSnapshot: () => [],
      inspectProcessLiveness: () => Promise.resolve(processLiveness),
      approvedWaitUntil: () => null
    }
  }

  async function worldWithLiveMarker() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'codex' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'pane_worker:leaf',
      processIncarnation: 'pty:term_worker',
      launchTokenHash: 'hash',
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db!.markWorkerDispatchReady(started.dispatch.id, [])
    // A first sweep while the worker is healthy writes the `live` marker.
    await runLivenessSweep({
      db: db!,
      runId: task.run_id,
      source: liveSource('live'),
      nowMs: NOW
    })
    expect(readLivenessMarker(new ControlPlaneStore(db!), started.dispatch.id, NOW).verdict).toBe(
      'live'
    )
    return { runId: task.run_id, dispatchId: started.dispatch.id }
  }

  it('never leaves a dead Dispatch reading `live` after it settles', async () => {
    const { runId, dispatchId } = await worldWithLiveMarker()

    // The worker process dies and the lifecycle settles the Dispatch — this is
    // exactly the window in which the old sweep dropped it and stopped looking.
    db!.db.prepare(`UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?`).run(dispatchId)

    await runLivenessSweep({
      db: db!,
      runId,
      source: liveSource('exited'),
      nowMs: NOW + 1000
    })

    const marker = readLivenessMarker(new ControlPlaneStore(db!), dispatchId, NOW + 1000)
    expect(marker.verdict).not.toBe('live')
    expect(marker.verdict).toBe('exited')
    expect(marker.expired).toBe(false)
  })

  it('marks the finalized verdict terminal so a later sweep cannot revive it', async () => {
    const { runId, dispatchId } = await worldWithLiveMarker()
    db!.db.prepare(`UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?`).run(dispatchId)
    await runLivenessSweep({ db: db!, runId, source: liveSource('exited'), nowMs: NOW + 1000 })

    // A late sweep that somehow sees the process as live must not resurrect it.
    await runLivenessSweep({ db: db!, runId, source: liveSource('live'), nowMs: NOW + 2000 })
    expect(readLivenessMarker(new ControlPlaneStore(db!), dispatchId, NOW + 2000).verdict).toBe(
      'exited'
    )
  })

  it('still sweeps active Dispatches normally', async () => {
    const { runId, dispatchId } = await worldWithLiveMarker()
    const result = await runLivenessSweep({
      db: db!,
      runId,
      source: liveSource('live'),
      nowMs: NOW + 1000
    })
    expect(result.swept).toBe(1)
    expect(readLivenessMarker(new ControlPlaneStore(db!), dispatchId, NOW + 1000).verdict).toBe(
      'live'
    )
  })
})

/** The same false `live`, seen through the B10 recovery query — which is
 *  read-only and therefore cannot sweep. Observed on candidate
 *  `ac2003d1-42b2-465a-8aaf-0718718de1b2`, Dispatch `ctx_c2046c8f7f6d`:
 *  `worker-show` said `failed / process_exited` while `orchestration state`
 *  answered `verdict: live`. Recovery must never contradict the lifecycle. */
describe('CRASHED_DISPATCH_RECOVERY_QUERY_REPORTS_LIVE', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const NOW = Date.parse('2026-08-27T18:00:00Z')

  it('reports a settled Dispatch as exited even while a live marker is unexpired', () => {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    store.putLivenessMarker({
      dispatch_id: 'ctx_1',
      verdict: 'live',
      activity: 'working',
      reason: 'Worker produced output within the stall window.',
      observed_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + 300_000).toISOString(),
      epoch: null,
      woke_for: null,
      terminal: 0
    })
    // Without the Dispatch's own verdict the stale marker wins — the bug.
    expect(readLivenessMarker(store, 'ctx_1', NOW + 1000).verdict).toBe('live')
    // With it, the lifecycle outranks the marker.
    const settled = readLivenessMarker(store, 'ctx_1', NOW + 1000, true)
    expect(settled.verdict).toBe('exited')
    expect(settled.activity).toBe('settled')
  })
})
