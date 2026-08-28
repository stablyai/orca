import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome, outcomeFingerprint } from './outcome-identity'
import { requireLeaseOwnerAuthority } from './lease-owner-authority'
import { validationScopeKeyForWorktree } from './validation-scope'

const IMPLEMENTATION = 'repo_a::/work/jb-workflow-control-plane-b'
const DISPOSABLE = 'repo_a::/tmp/orca-cert-workspace'
const SCOPE = validationScopeKeyForWorktree(IMPLEMENTATION)

describe('who may own or release a lease on a workspace', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function place(taskId: string, handle: string, worktreeId: string | null): string {
    const started = db.createStartingWorkerDispatch({
      taskId,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'claude' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey: `${handle}:leaf`,
      processIncarnation: `pty:${handle}`,
      launchTokenHash: 'hash',
      worktreeId: worktreeId ?? IMPLEMENTATION,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    if (!worktreeId) {
      // Full process authority, but no resolvable workspace — so the worktree
      // check is the only thing left that can refuse it.
      db.db
        .prepare('UPDATE worker_dispatches SET worktree_id = NULL WHERE dispatch_id = ?')
        .run(started.dispatch.id)
    }
    return started.dispatch.id
  }

  function seed(options: { admitOutcome?: boolean } = {}) {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'gate the implementation tree' })
    const other = db.createTask({ spec: 'certification worker', runId: task.run_id })
    const third = db.createTask({ spec: 'never placed', runId: task.run_id })
    if (options.admitOutcome !== false) {
      admitOutcome(new ControlPlaneStore(db), {
        outcomeId: 'out_1',
        runId: task.run_id,
        title: 'Package B',
        fingerprint: outcomeFingerprint(['package', 'b'])
      })
    }
    return {
      runId: task.run_id,
      taskId: task.id,
      otherTaskId: other.id,
      here: place(task.id, 'term_gate', IMPLEMENTATION),
      elsewhere: place(other.id, 'term_cert', DISPOSABLE),
      unplacedTaskId: third.id,
      unplaced: place(third.id, 'term_unplaced', null)
    }
  }

  it('admits the Dispatch actually placed in the workspace', () => {
    const { runId, taskId, here } = seed()
    expect(requireLeaseOwnerAuthority(db, { dispatchId: here, runId, taskId })).toMatchObject({
      dispatchId: here,
      worktreeId: IMPLEMENTATION,
      outcomeId: 'out_1',
      taskId,
      // The scope comes from the owner Dispatch's own worktree, never from
      // whichever terminal happened to call.
      scopeKey: SCOPE
    })
  })

  it('NEGATIVE CONTROL: a Dispatch elsewhere gets its OWN workspace, not this one', () => {
    // Sharing a Run is not authority over a workspace. The scope now follows the
    // owner Dispatch, so a certification worker in a disposable tree can only
    // ever lease that tree — never the implementation checkout.
    const { runId, otherTaskId, elsewhere } = seed()
    expect(
      requireLeaseOwnerAuthority(db, { dispatchId: elsewhere, runId, taskId: otherTaskId })
    ).toMatchObject({
      worktreeId: DISPOSABLE,
      scopeKey: validationScopeKeyForWorktree(DISPOSABLE)
    })
    expect(
      requireLeaseOwnerAuthority(db, { dispatchId: elsewhere, runId, taskId: otherTaskId }).scopeKey
    ).not.toBe(SCOPE)
  })

  it('NEGATIVE CONTROL: an unplaced Dispatch cannot own the lease', () => {
    const { runId, unplacedTaskId, unplaced } = seed()
    expect(() =>
      requireLeaseOwnerAuthority(db, {
        dispatchId: unplaced,
        runId,
        taskId: unplacedTaskId
      })
    ).toThrow(/no worktree the runtime can resolve/)
  })

  it('NEGATIVE CONTROL: a Run with no admitted outcome cannot hold a lease', () => {
    const { runId, taskId, here } = seed({ admitOutcome: false })
    expect(() => requireLeaseOwnerAuthority(db, { dispatchId: here, runId, taskId })).toThrow(
      /no admitted outcome/
    )
  })

  it('refuses a Dispatch on another Run', () => {
    const { taskId, here } = seed()
    expect(() =>
      requireLeaseOwnerAuthority(db, {
        dispatchId: here,
        runId: 'run_someone_else',
        taskId
      })
    ).toThrow(/is not a Dispatch on Run/)
  })

  it('refuses a Dispatch that belongs to a different Task than the caller named', () => {
    const { runId, otherTaskId, here } = seed()
    expect(() =>
      requireLeaseOwnerAuthority(db, {
        dispatchId: here,
        runId,
        taskId: otherTaskId
      })
    ).toThrow(/belongs to Task/)
  })

  it('refuses a Dispatch id that names nothing', () => {
    const { runId, taskId } = seed()
    expect(() =>
      requireLeaseOwnerAuthority(db, {
        dispatchId: 'ctx_invented',
        runId,
        taskId
      })
    ).toThrow(/is not a Dispatch on Run/)
  })
})
