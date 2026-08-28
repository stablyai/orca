import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { createObservedWorktree, type ObservedWorktreeFixture } from './observed-worktree-fixture'
import { observeCompletion } from './runtime-observed-completion'
import {
  validateCompletionReceipt,
  type CompletionClaim,
  type CompletionExpectation,
  type RuntimeCompletionObservation
} from './completion-receipt'

/** RUNTIME_OWNED_COMPLETION_PROOF — the blocked head compared the worker's
 *  `claimedSha` against the worker's `headSha` and read the worker's
 *  `worktreeClean`. Every one of those arrives in the same payload, so the gate
 *  proved only that the worker was internally consistent with itself. A worker
 *  that sent two equal SHAs, `worktreeClean: true` and `result: 'PASS'` walked
 *  straight through a gate that had observed nothing.
 */
describe('RUNTIME_OWNED_COMPLETION_PROOF', () => {
  const HEAD = 'a1b2c3d4e5f6'
  const OTHER = 'f6e5d4c3b2a1'

  const expected: CompletionExpectation = {
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    runId: 'run_1',
    outcomeId: 'out_1',
    requireReceipt: true
  }

  function claim(overrides: Partial<CompletionClaim> = {}): CompletionClaim {
    return {
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      runId: 'run_1',
      outcomeId: 'out_1',
      headSha: HEAD,
      claimedSha: HEAD,
      worktreeClean: true,
      placement: 'local',
      receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' },
      ...overrides
    }
  }

  function observed(
    overrides: Partial<RuntimeCompletionObservation> = {}
  ): RuntimeCompletionObservation {
    return {
      observable: true,
      headSha: HEAD,
      clean: true,
      changedFiles: [],
      reason: null,
      ...overrides
    }
  }

  it('rejects a fabricated worker PASS the runtime never saw', () => {
    // The perfectly self-consistent payload the old gate accepted.
    const fabricated = claim()
    // The runtime looked at the tree and it is on a different commit entirely.
    expect(
      validateCompletionReceipt(fabricated, expected, observed({ headSha: OTHER }))
    ).toMatchObject({ ok: false, code: 'sha_not_observed', gate: 'runtime_observation' })
  })

  it('rejects equal claimed SHAs when the runtime observed something else', () => {
    expect(
      validateCompletionReceipt(
        claim({ headSha: HEAD, claimedSha: HEAD }),
        expected,
        observed({ headSha: OTHER })
      )
    ).toMatchObject({ ok: false, code: 'sha_not_observed' })
  })

  it('rejects a claimed clean tree the runtime observed as dirty', () => {
    expect(
      validateCompletionReceipt(
        claim({ worktreeClean: true }),
        expected,
        observed({ clean: false })
      )
    ).toMatchObject({ ok: false, code: 'worktree_dirty', gate: 'runtime_observation' })
  })

  it('fails closed when no runtime observation is supplied at all', () => {
    expect(validateCompletionReceipt(claim(), expected)).toMatchObject({
      ok: false,
      code: 'evidence_unobservable',
      gate: 'runtime_observation'
    })
  })

  it('fails closed when the runtime could not read the worktree', () => {
    expect(
      validateCompletionReceipt(
        claim(),
        expected,
        observed({ observable: false, headSha: null, clean: null, reason: 'worktree is gone' })
      )
    ).toMatchObject({ ok: false, code: 'evidence_unobservable' })
  })

  it('accepts only when the runtime independently corroborates the claim', () => {
    expect(validateCompletionReceipt(claim(), expected, observed())).toEqual({
      ok: true,
      finalSha: HEAD
    })
  })

  it('refuses a PASS receipt with no runtime-owned gate execution behind it', () => {
    expect(validateCompletionReceipt(claim(), expected, observed(), false)).toMatchObject({
      ok: false,
      code: 'gate_not_executed',
      gate: 'receipt_result'
    })
  })

  it('accepts the same PASS once the runtime itself ran the gate', () => {
    expect(validateCompletionReceipt(claim(), expected, observed(), true)).toEqual({
      ok: true,
      finalSha: HEAD
    })
  })
})

/** LOCAL_GIT_ANSWERS_FOR_A_REMOTE_TREE — the runtime observation ran git on
 *  THIS machine against the Dispatch's recorded worktree path. For an SSH or
 *  WSL worker that path belongs to another host, and an identical path can also
 *  exist locally, so the observation would answer confidently for the wrong
 *  repository. docs/reference/ssh-execution-boundary.md forbids exactly that
 *  substitution: the execution host owns everything that touches execution.
 */
describe('LOCAL_GIT_ANSWERS_FOR_A_REMOTE_TREE', () => {
  let db: OrchestrationDb | undefined
  let tree: ObservedWorktreeFixture | undefined
  afterEach(() => {
    db?.close()
    db = undefined
    tree?.cleanup()
    tree = undefined
  })

  function dispatchOn(hostScope: Record<string, unknown> | null): string {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
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
      worktreeId: tree!.worktreeId,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    if (hostScope) {
      db.db
        .prepare(`UPDATE worker_terminal_resources SET host_scope = ? WHERE owner_dispatch_id = ?`)
        .run(JSON.stringify(hostScope), started.dispatch.id)
    }
    return started.dispatch.id
  }

  // A federated Dispatch records the REMOTE host's absolute path in the same
  // worktree_id column a local Dispatch uses, and never gets a
  // worker_terminal_resources row — so there is no host_scope to carry a kind
  // and the ssh/wsl guard above never fires for it.
  function federatedDispatchOn(worktreeId: string): string {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'claude', on: 'env_remote', serverName: 'peer' },
      federation: {
        environmentId: 'env_remote',
        environmentName: 'peer',
        peerFingerprint: 'fp',
        protocolVersion: 1
      }
    })
    db.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'remote_input_accepted',
      worktreeId,
      terminalHandle: 'term_remote'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return started.dispatch.id
  }

  it('declines to answer for a federated worker even when the path exists locally', () => {
    tree = createObservedWorktree()
    // The remote's path resolves here too — that is exactly the trap.
    const dispatchId = federatedDispatchOn(tree.worktreeId)

    const observed = observeCompletion({ db: db!, dispatchId })

    expect(observed.observable).toBe(false)
    expect(observed.headSha).toBeNull()
    expect(observed.reason).toContain('federated environment')
  })

  it('declines to answer for an SSH worker even when the path exists locally', () => {
    tree = createObservedWorktree()
    const dispatchId = dispatchOn({ kind: 'ssh', targetId: 'prod-box' })
    const observed = observeCompletion({ db: db!, dispatchId })
    // The tree IS readable here — that is exactly the trap.
    expect(observed).toMatchObject({ observable: false, headSha: null })
    expect(observed.reason).toContain('prod-box')
  })

  it('declines for a WSL worker for the same reason', () => {
    tree = createObservedWorktree()
    const dispatchId = dispatchOn({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' })
    const observed = observeCompletion({ db: db!, dispatchId })
    expect(observed).toMatchObject({ observable: false })
    expect(observed.reason).toContain('Ubuntu')
  })

  it('negative control: a local worker in the same tree IS observed', () => {
    tree = createObservedWorktree()
    const dispatchId = dispatchOn({ kind: 'local', hostId: 'local' })
    const observed = observeCompletion({ db: db!, dispatchId })
    expect(observed).toMatchObject({ observable: true, clean: true, headSha: tree.headSha })
  })

  it('reports no changed files when the runtime-recorded base already equals HEAD', () => {
    tree = createObservedWorktree()
    const dispatchId = dispatchOn({ kind: 'local', hostId: 'local' })
    const observed = observeCompletion({
      db: db!,
      dispatchId,
      baseSha: tree.headSha
    })
    expect(observed).toMatchObject({ observable: true, changedFiles: [] })
  })

  it('derives every path across a multi-commit Dispatch from the recorded base', () => {
    tree = createObservedWorktree()
    const baseSha = tree.headSha
    const dispatchId = dispatchOn({ kind: 'local', hostId: 'local' })
    tree.commit('first-change.txt')
    tree.commit('second-change.txt')
    const observed = observeCompletion({ db: db!, dispatchId, baseSha })
    expect(observed.changedFiles).toEqual(['first-change.txt', 'second-change.txt'])
  })
})
