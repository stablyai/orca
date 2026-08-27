import { ControlPlaneStore } from '../orchestration/control-plane/control-plane-store'
import { assertMutationAllowed } from '../orchestration/control-plane/validation-lease'
import { validationScopeKeyForWorktree } from '../orchestration/control-plane/validation-scope'
import type { OrcaRuntimeService } from '../orca-runtime'

/** Blocker 4 — the validation lease was consulted by exactly ONE call site,
 *  `orchestration.workerStart`'s local branch. Every other Orca-managed mutation
 *  — `git.commit`, `files.write`, `terminal.send`, `worktree.rm`, `repo.update`
 *  — reached the worktree with no fence at all, so a reproduction could edit the
 *  tree out from under a running gate and the receipt would still be recorded.
 *
 *  Why one fence at the dispatcher instead of a guard per method: the invariant
 *  is "no Orca-managed mutation of a leased worktree", which is a property of
 *  the boundary, not of any one handler. Twenty guards is twenty chances for the
 *  twenty-first method to be added without one.
 */

/** Every RPC that can change a worktree's contents or its running processes.
 *  Read-only methods are deliberately absent: a lease blocks mutation, not
 *  inspection. */
export const LEASE_FENCED_METHODS: ReadonlySet<string> = new Set([
  'git.commit',
  'git.checkout',
  'git.stage',
  'git.bulkStage',
  'git.unstage',
  'git.bulkUnstage',
  'git.discard',
  'git.bulkDiscard',
  'git.push',
  'git.rebaseFromBase',
  'git.abortMerge',
  'git.abortRebase',
  'files.write',
  'files.writeBase64',
  'files.createFile',
  'files.createDir',
  'files.rename',
  'files.copy',
  'files.delete',
  'terminal.send',
  'worktree.rm',
  'worktree.forceDeleteBranch',
  'repo.rm',
  'repo.update',
  'repo.setBaseRef'
])

export class ValidationLeaseFenced extends Error {
  readonly code = 'validation_in_progress'
  constructor(
    message: string,
    readonly data: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ValidationLeaseFenced'
  }
}

type FenceableParams = { worktree?: unknown; terminal?: unknown }

/** The worktree id a mutating call targets, or null when none is resolvable.
 *  `worktree` is a selector the runtime resolves; `terminal` is a handle whose
 *  pane already belongs to a worktree. */
async function targetWorktreeId(
  runtime: OrcaRuntimeService,
  params: FenceableParams
): Promise<string | null> {
  try {
    if (typeof params.worktree === 'string' && params.worktree.length > 0) {
      return (await runtime.showManagedTerminalWorkspace(params.worktree)).id
    }
    if (typeof params.terminal === 'string' && params.terminal.length > 0) {
      return (await runtime.showTerminal(params.terminal)).worktreeId ?? null
    }
  } catch {
    // Why not a throw: an unresolvable selector is the handler's error to
    // report, and turning it into a fence error would mask it.
    return null
  }
  return null
}

/** Throws when the target worktree is under someone else's active validation
 *  lease. A no-op for every read, and for every worktree with no live lease.
 *
 *  Called from the dispatcher rather than from each handler, because the
 *  invariant belongs to the boundary: twenty guards is twenty chances for the
 *  twenty-first mutating method to be added without one. */
export async function assertNotFencedByValidationLease(
  runtime: OrcaRuntimeService,
  method: string,
  params: unknown,
  nowMs?: number
): Promise<void> {
  if (!LEASE_FENCED_METHODS.has(method) || !params || typeof params !== 'object') {
    return
  }
  // Why resolve the selector only after a lease is known to exist: resolution
  // costs a runtime lookup on every mutating call, and no lease is the norm.
  // A runtime with no orchestration database has no leases and no fence.
  let store: ControlPlaneStore
  try {
    const db = runtime.getOrchestrationDb()
    if (!db) {
      return
    }
    store = new ControlPlaneStore(db)
    if (!store.hasAnyActiveValidationLease(new Date(nowMs ?? Date.now()).toISOString())) {
      return
    }
  } catch {
    return
  }
  const worktreeId = await targetWorktreeId(runtime, params as FenceableParams)
  if (!worktreeId) {
    return
  }
  const guard = assertMutationAllowed(store, {
    scopeKey: validationScopeKeyForWorktree(worktreeId),
    nowMs: nowMs ?? Date.now()
  })
  if (!guard.allowed) {
    throw new ValidationLeaseFenced(guard.reason, {
      lease: guard.lease,
      remedies: guard.remedies,
      method,
      worktreeId
    })
  }
}
