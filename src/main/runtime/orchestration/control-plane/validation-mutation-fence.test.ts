import { afterEach, describe, expect, it } from 'vitest'
import { assertWorkerStartAdmitted } from '../../rpc/methods/orchestration-worker-route-admission'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { acquireValidationLease, releaseValidationLease } from './validation-lease'
import { validationScopeKeyForWorktree } from './validation-scope'

/** VALIDATION_MUTATION_FENCE — the fence was consulted only when a start named
 *  an explicit worktree. A retained re-engagement names a TERMINAL, so driving
 *  an already-running builder back into a worktree under validation skipped the
 *  lease entirely — exactly the contamination the lease exists to prevent.
 */
describe('VALIDATION_MUTATION_FENCE', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  // Why real now: the production fence stamps its own Date.now(), so a lease
  // pinned to a fixed past instant would already be expired when it looks.
  const NOW = Date.now()
  const WORKTREE = 'wt_protected'
  // The lease protects the WORKTREE scope, which is what the fence reads.
  const SCOPE = validationScopeKeyForWorktree(WORKTREE)

  function runningBuilder() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'build' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'codex' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_builder',
      paneKey: 'pane:leaf',
      processIncarnation: 'pty:term_builder',
      launchTokenHash: 'hash',
      worktreeId: WORKTREE,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    return { runId: task.run_id, taskId: task.id, dispatchId: started.dispatch.id }
  }

  function holdLease(owner: string) {
    return acquireValidationLease(new ControlPlaneStore(db!), {
      scopeKey: SCOPE,
      leaseId: 'lease_1',
      owner,
      idempotencyKey: 'idem_1',
      nowMs: NOW
    })
  }

  it('blocks driving an already-running builder into a worktree under validation', () => {
    const { runId, taskId } = runningBuilder()
    expect(holdLease('ctx_validator').ok).toBe(true)
    // The re-engagement names only the terminal — no worktree in the request.
    expect(() =>
      assertWorkerStartAdmitted({
        handle: db!,
        runId,
        taskId,
        agent: 'codex',
        terminalHandle: 'term_builder'
      })
    ).toThrow(/validation_in_progress|Validation lease/)
  })

  it('offers only the approved remedies: wait, or use a separate worktree', () => {
    const { runId, taskId } = runningBuilder()
    holdLease('ctx_validator')
    let thrown: unknown
    try {
      assertWorkerStartAdmitted({
        handle: db!,
        runId,
        taskId,
        agent: 'codex',
        terminalHandle: 'term_builder'
      })
    } catch (error) {
      thrown = error
    }
    const data = (thrown as { data?: { remedies?: string[] } }).data
    expect(data?.remedies).toEqual(['wait_for_lease_completion', 'use_separate_worktree'])
  })

  it('lets the same start through once the rightful owner releases', () => {
    const { runId, taskId } = runningBuilder()
    holdLease('ctx_validator')
    const store = new ControlPlaneStore(db!)
    // A different owner holding the same lease id may NOT release it.
    expect(
      releaseValidationLease(store, {
        scopeKey: SCOPE,
        leaseId: 'lease_1',
        nowMs: NOW + 1,
        owner: 'ctx_impostor'
      }).released
    ).toBe(false)
    expect(
      releaseValidationLease(store, {
        scopeKey: SCOPE,
        leaseId: 'lease_1',
        nowMs: NOW + 2,
        owner: 'ctx_validator'
      }).released
    ).toBe(true)
    expect(() =>
      assertWorkerStartAdmitted({
        handle: db!,
        runId,
        taskId,
        agent: 'codex',
        terminalHandle: 'term_builder'
      })
    ).not.toThrow()
  })

  it('recovers deterministically from a crashed holder by expiry, not by force', () => {
    runningBuilder()
    const store = new ControlPlaneStore(db!)
    acquireValidationLease(store, {
      scopeKey: SCOPE,
      leaseId: 'lease_crashed',
      owner: 'ctx_dead',
      idempotencyKey: 'idem_crashed',
      nowMs: NOW,
      ttlMs: 1000
    })
    // Still held before expiry, whoever asks.
    expect(
      acquireValidationLease(store, {
        scopeKey: SCOPE,
        leaseId: 'lease_next',
        owner: 'ctx_other',
        idempotencyKey: 'idem_next',
        nowMs: NOW + 500
      })
    ).toMatchObject({ ok: false, code: 'held_by_other_owner' })
    // Reclaimed only once the clock says the dead owner's lease expired.
    expect(
      acquireValidationLease(store, {
        scopeKey: SCOPE,
        leaseId: 'lease_next',
        owner: 'ctx_other',
        idempotencyKey: 'idem_next',
        nowMs: NOW + 2000
      })
    ).toMatchObject({ ok: true, reclaimed: true })
  })
})
