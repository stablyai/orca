import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

// Residual M: reconcileUnsupervisedDispatchesOnRestart (orchestration-unsupervised-dispatch-
// recovery.ts) correctly settles an injected/context-only Dispatch whose terminal is gone, but
// had no production caller -- orca serve, orcad, and the desktop renderer-startup path all only
// ever ran the supervised sweep (legacyWorkerRecovery.reconcile), which never sees a Dispatch
// with no worker_dispatches row. This is the runtime-level proof that
// reconcileLegacyWorkerTerminals() -- the one method every one of those callers shares -- now
// also fails such a Dispatch. Before the fix this dispatch is left dispatched forever.
describe('reconcileLegacyWorkerTerminals wires unsupervised dispatch recovery (residual M)', () => {
  let runtime: OrcaRuntimeService | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createInjectedDispatch(d: OrchestrationDb) {
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'injected work' })
    return d.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_never_created',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
  }

  it('fails an injected dispatch whose terminal is gone after the supervised sweep runs', async () => {
    runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const dispatch = createInjectedDispatch(db)
    // Why stub the owner's answer: a PTY-host `terminal_gone` is the runtime saying "no such
    // terminal" (owner-proven absence). A bare runtime with no PTY provider answers
    // `runtime_unavailable` instead, which is loss of contact and must never fail a dispatch (see
    // the next case).
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(
      Object.assign(new Error('terminal_gone'), { code: 'terminal_gone' })
    )

    await runtime.reconcileLegacyWorkerTerminals()

    const after = db.getDispatchContextById(dispatch.id)
    expect(after?.status).toBe('failed')
    expect(after?.termination_reason).toBe('unknown')
  })

  it('leaves an injected dispatch untouched when the host cannot be asked', async () => {
    runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const dispatch = createInjectedDispatch(db)
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('runtime_unavailable'))

    await runtime.reconcileLegacyWorkerTerminals()

    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  // O2: terminal_handle_stale describes a renderer graph-epoch mismatch or a missing/mismatched
  // local leaf, not the execution owner's process. Before O2 this was treated as owner-proven
  // `missing`, so injected recovery settled (failed) a dispatch whose execution may still exist.
  it('leaves an injected dispatch untouched when its terminal handle is merely stale', async () => {
    runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const dispatch = createInjectedDispatch(db)
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(
      Object.assign(new Error('terminal_handle_stale'), { code: 'terminal_handle_stale' })
    )

    await runtime.reconcileLegacyWorkerTerminals()

    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  // O2: orca-runtime-automation-operations.ts caught the unsupervised sweep's error and only
  // logged it, so a caller polling the returned result had no way to tell the sweep ran and
  // failed versus ran and found nothing to do.
  it('surfaces a failed unsupervised recovery sweep on the returned result instead of dropping it', async () => {
    runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    createInjectedDispatch(db)
    vi.spyOn(db, 'listUnsupervisedActiveDispatches').mockImplementation(() => {
      throw new Error('unsupervised_sweep_boom')
    })

    const result = await runtime.reconcileLegacyWorkerTerminals()

    expect(result.unsupervisedRecoveryError).toBe('unsupervised_sweep_boom')
  })
})
