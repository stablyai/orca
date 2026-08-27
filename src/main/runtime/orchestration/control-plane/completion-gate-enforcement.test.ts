import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { reconcileLifecycleMessage } from '../lifecycle-reconciliation'
import { ControlPlaneStore } from './control-plane-store'
import {
  createObservedWorktree,
  recordProvenGate,
  type ObservedWorktreeFixture
} from './observed-worktree-fixture'
import { admitOutcome } from './outcome-identity'

// A real tree, because the gate reads HEAD itself rather than believing the claim.
let worktree: ObservedWorktreeFixture
let HEAD = ''
const OLDER = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'

describe('B6 gate on the real worker_done path', () => {
  let db: OrchestrationDb
  beforeAll(() => {
    worktree = createObservedWorktree()
    HEAD = worktree.headSha
  })
  afterAll(() => worktree.cleanup())
  afterEach(() => db?.close())

  function setup(options: { admit: boolean; tree?: ObservedWorktreeFixture }) {
    const tree = options.tree ?? worktree
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'ship it' })
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
      processIncarnation: 'pty:term_worker',
      launchTokenHash: 'hash',
      worktreeId: tree.worktreeId,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    const dispatch = db.getDispatchContextById(started.dispatch.id)!
    if (options.admit) {
      admitOutcome(store, {
        outcomeId: 'out_1',
        runId: task.run_id,
        title: 'Ship it',
        fingerprint: 'f1'
      })
      // The gate now also demands a runtime-run gate process, not a claimed PASS.
      recordProvenGate(store, {
        scopeKey: `${task.run_id}:out_1`,
        gateId: 'pnpm test',
        finalSha: tree.headSha
      })
    }
    return { task, dispatch }
  }

  function completion(overrides: Record<string, unknown> = {}) {
    return {
      runId: '',
      outcomeId: 'out_1',
      headSha: HEAD,
      claimedSha: HEAD,
      worktreeClean: true,
      placement: 'local',
      ...overrides
    }
  }

  function report(args: {
    task: { id: string }
    dispatch: { id: string }
    completionBlock?: Record<string, unknown> | null
  }) {
    return db.insertMessage({
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      senderPaneKey: 'term_worker:leaf',
      payload: JSON.stringify({
        taskId: args.task.id,
        dispatchId: args.dispatch.id,
        outcome: 'succeeded',
        ...(args.completionBlock === null
          ? {}
          : {
              completion: {
                taskId: args.task.id,
                dispatchId: args.dispatch.id,
                ...completion(args.completionBlock ?? {})
              }
            })
      })
    })
  }

  it('accepts a completion whose receipt is bound to the exact final HEAD', () => {
    const { task, dispatch } = setup({ admit: true })
    const message = report({
      task,
      dispatch,
      completionBlock: {
        receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(reconcileLifecycleMessage(db, message)).toMatchObject({ action: 'completed' })
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('rejects a PASS receipt produced against an older SHA and leaves the Task open', () => {
    const { task, dispatch } = setup({ admit: true })
    const logs: string[] = []
    const message = report({
      task,
      dispatch,
      completionBlock: {
        receipt: { sha: OLDER, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(reconcileLifecycleMessage(db, message, (line) => logs.push(line))).toMatchObject({
      action: 'rejected',
      code: 'completion_receipt_invalid'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(logs.some((line) => line.includes('receipt_sha'))).toBe(true)
  })

  it('rejects a worktree the runtime reads as dirty even when the worker claims it clean', () => {
    const tree = createObservedWorktree('repo_dirty')
    tree.dirty()
    const { task, dispatch } = setup({ admit: true, tree })
    const message = report({
      task,
      dispatch,
      completionBlock: {
        headSha: tree.headSha,
        claimedSha: tree.headSha,
        worktreeClean: true,
        receipt: {
          sha: tree.headSha,
          result: 'PASS',
          policyVersion: 'v1',
          commandIdentity: 'pnpm test'
        }
      }
    })
    expect(reconcileLifecycleMessage(db, message)).toMatchObject({
      action: 'rejected',
      code: 'completion_receipt_invalid'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    tree.cleanup()
  })

  it('rejects a completion claiming the wrong outcome', () => {
    const { task, dispatch } = setup({ admit: true })
    const message = report({
      task,
      dispatch,
      completionBlock: {
        outcomeId: 'out_other',
        receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(reconcileLifecycleMessage(db, message)).toMatchObject({
      action: 'rejected',
      code: 'completion_receipt_invalid'
    })
  })

  it('rejects an admitted-Run completion that carries no completion block at all', () => {
    const { task, dispatch } = setup({ admit: true })
    const message = report({ task, dispatch, completionBlock: null })
    expect(reconcileLifecycleMessage(db, message)).toMatchObject({
      action: 'rejected',
      code: 'completion_receipt_invalid'
    })
  })

  it('compatibility: a legacy Run with no admitted outcome completes exactly as before', () => {
    const { task, dispatch } = setup({ admit: false })
    const message = report({ task, dispatch, completionBlock: null })
    expect(reconcileLifecycleMessage(db, message)).toMatchObject({ action: 'completed' })
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('retry idempotency: a rejected completion can be resent with the fixed gate and then settles once', () => {
    const { task, dispatch } = setup({ admit: true })
    const stale = report({
      task,
      dispatch,
      completionBlock: {
        receipt: { sha: OLDER, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(reconcileLifecycleMessage(db, stale)).toMatchObject({ action: 'rejected' })

    const fixed = report({
      task,
      dispatch,
      completionBlock: {
        receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(reconcileLifecycleMessage(db, fixed)).toMatchObject({ action: 'completed' })

    // A duplicate of the accepted report is idempotent: same verdict, and the
    // settled Task is not re-settled with a new completion timestamp.
    const settledAt = db.getTask(task.id)?.completed_at
    const duplicate = report({
      task,
      dispatch,
      completionBlock: {
        receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(reconcileLifecycleMessage(db, duplicate)).toMatchObject({ action: 'completed' })
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getTask(task.id)?.completed_at).toBe(settledAt)
  })
})
