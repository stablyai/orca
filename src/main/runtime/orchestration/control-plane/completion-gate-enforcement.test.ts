import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from '../lifecycle-reconciliation'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome } from './outcome-identity'

const HEAD = 'a1b2c3d4e5f6'
const OLDER = '0f0f0f0f0f0f'

describe('B6 gate on the real worker_done path', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function setup(options: { admit: boolean }) {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'ship it' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    if (options.admit) {
      admitOutcome(store, {
        outcomeId: 'out_1',
        runId: task.run_id,
        title: 'Ship it',
        fingerprint: 'f1'
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

  it('rejects a dirty worktree', () => {
    const { task, dispatch } = setup({ admit: true })
    const message = report({
      task,
      dispatch,
      completionBlock: {
        worktreeClean: false,
        receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(reconcileLifecycleMessage(db, message)).toMatchObject({
      action: 'rejected',
      code: 'completion_receipt_invalid'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
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
