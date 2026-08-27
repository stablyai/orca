import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'

/** REJECTED_WORKER_DONE_NOT_TERMINAL — observed live on Dispatch
 *  `ctx_de358c6c53b2` (Run `run_940419794b63`): a `worker_done` sent without
 *  the Dispatch capability came back as
 *  `{code: dispatch_capability_invalid, message: "The Dispatch capability is missing."}`
 *  and nothing else.
 *
 *  Two halves to the contract, and only the first one held:
 *    1. the Dispatch must stay ACTIVE — it did (status `dispatched`,
 *       capability_revoked_at null, completed_at null);
 *    2. the worker must get ONE bounded machine-actionable recovery
 *       instruction, distinguishable from an accepted completion — it did not.
 *  A bare code reads like a terminal failure, which is the exact confusion
 *  that makes a worker either give up or resend a second rejected completion.
 */
describe('REJECTED_WORKER_DONE_NOT_TERMINAL', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  function dispatchedWorker() {
    db = new OrchestrationDb(':memory:')
    const task = db!.createTask({ spec: 'do the thing' })
    const started = db!.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'codex' }
    })
    db!.prepareStartingWorkerAuthority({
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
    return { taskId: task.id, dispatchId: started.dispatch.id }
  }

  it('leaves the Dispatch active when a completion is rejected for a missing capability', () => {
    const { taskId, dispatchId } = dispatchedWorker()
    const capability = db!.mintDispatchCapability({
      dispatchId,
      paneKey: 'pane_worker:leaf',
      processIncarnation: 'pty:term_worker'
    })
    expect(capability.startsWith('dcap_')).toBe(true)

    const verdict = db!.verifyDispatchCapability({
      dispatchId,
      capability: undefined,
      paneKey: 'pane_worker:leaf',
      processIncarnation: 'pty:term_worker'
    })
    expect(verdict).toEqual({ valid: false, reason: 'The Dispatch capability is missing.' })

    // The rejection must not settle anything: the worker can still recover.
    const dispatch = db!.getDispatchContextById(dispatchId)
    expect(dispatch?.status).toBe('dispatched')
    expect(dispatch?.capability_revoked_at).toBeFalsy()
    expect(dispatch?.completed_at).toBeFalsy()
    expect(db!.getTask(taskId)?.status).not.toBe('completed')

    // The other half of the contract — that the rejection carries one bounded
    // recovery instruction — is asserted in
    // src/cli/handlers/orchestration-lifecycle-rejection.test.ts, which owns
    // the CLI error boundary that surfaces it.
    // And the same capability still works, so recovery is a resend, not a restart.
    expect(
      db!.verifyDispatchCapability({
        dispatchId,
        capability,
        paneKey: 'pane_worker:leaf',
        processIncarnation: 'pty:term_worker'
      })
    ).toEqual({ valid: true })
  })
})
