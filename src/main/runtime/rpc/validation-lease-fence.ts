import {
  ControlPlaneStore,
  type ControlPlaneDatabaseHandle
} from '../orchestration/control-plane/control-plane-store'
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
 *  inspection.
 *
 *  Keep this exhaustive against the git and files method registries. A mutating
 *  method missing from here is unfenced, which is the failure this single fence
 *  exists to prevent — `validation-lease-fence.test.ts` pins the list against
 *  those registries so a newly added mutation cannot quietly skip it. */
export const LEASE_FENCED_METHODS: ReadonlySet<string> = new Set([
  'git.commit',
  'git.checkout',
  'git.pull',
  'git.fastForward',
  'git.forkSync',
  'git.conflictOperation',
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
  'files.writeBase64Chunk',
  'files.commitUpload',
  'files.createFile',
  'files.createDir',
  'files.createDirNoClobber',
  // Takes a worktree and an absolute path, so it can land bytes inside the tree.
  'files.writeTerminalArtifact',
  'files.rename',
  'files.copy',
  'files.delete',
  // Both can execute an arbitrary startup command in the target worktree.
  'terminal.create',
  'terminal.split',
  // These create or re-engage a model process that can mutate immediately.
  'terminal.ensureAgentSession',
  'terminal.createAgentSession',
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
    // Null, not a throw: an unresolvable selector is the handler's error to
    // report, and turning it into a fence error would mask it. The CALLER
    // decides what null means — and while a lease is active it means refuse,
    // because a mutation whose target cannot be named cannot be shown to land
    // outside the leased tree.
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
  // Three outcomes, and only two of them are a pass.
  //
  //   no orchestration surface at all -> nothing here can hold a lease
  //   a getter that returns null      -> the absence is PROVEN
  //   a getter that THROWS            -> nothing is proven; refuse
  //
  // The third used to be folded into the first. That made every control-plane
  // failure a pass on a path whose entire job is to refuse when it cannot tell.
  if (typeof runtime.getOrchestrationDb !== 'function') {
    return
  }
  let db: ControlPlaneDatabaseHandle | null
  try {
    db = runtime.getOrchestrationDb()
  } catch (error) {
    throw new ValidationLeaseFenced(
      `${method} cannot proceed: Orca could not read its orchestration state, so it cannot tell whether this worktree is under a validation lease.`,
      { method, reason: String(error) }
    )
  }
  if (!db) {
    return
  }
  // Why not inside the try above: a store or probe failure means we cannot tell
  // whether a lease is held, and "could not check" must never read as "clear".
  const store = new ControlPlaneStore(db)
  // Why probe before resolving the selector: resolution costs a runtime lookup
  // on every mutating call, and no lease at all is the overwhelmingly common case.
  if (!store.hasAnyActiveValidationLease(new Date(nowMs ?? Date.now()).toISOString())) {
    return
  }
  const worktreeId = await targetWorktreeId(runtime, params as FenceableParams)
  if (!worktreeId) {
    // Some lease IS active and this mutation's exact target cannot be resolved.
    // Letting it through is a bet that it lands somewhere unleased, and the
    // whole package exists because that bet was being made silently.
    throw new ValidationLeaseFenced(
      `${method} cannot proceed: a validation lease is active and Orca cannot resolve which worktree this request would mutate.`,
      { method, remedies: ['name_the_worktree', 'wait_for_lease_completion'] }
    )
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
