import type { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { assertMutationAllowed, type ValidationLease } from './validation-lease'
import { validationScopeKeyForWorktree } from './validation-scope'
import { isReadOnlyPhaseKind, readDispatchPhaseKind } from './dispatch-phase-role'

/** Correction — the fence has to reach the worker that is ALREADY running.
 *
 *  The dispatcher fence covers Orca-managed RPC: `terminal.send`, `files.write`,
 *  `git.commit`. A worker that is already up does not use any of them. It edits
 *  through its own Bash and Edit tools, inside a shell that existed before the
 *  lease was taken, and that is exactly how two certification workers committed
 *  to the Package B branch while a gate was running. Fencing `terminal.send`
 *  fences the channel Orca would use to talk TO the worker — not the worker.
 *
 *  There is one synchronous point before a worker's own tool runs: the provider's
 *  PreToolUse/BeforeTool hook. Orca duplicates no policy and decides none of its
 *  own. It answers one question the policy cannot answer for itself — "is the
 *  workspace this session occupies under someone else's validation lease?" — and
 *  the hook denies on that answer, before the tool executes.
 *
 *  Nothing here is caller-supplied. The Dispatch, its process incarnation, its
 *  workspace and the lease are all read from Orca's own records, keyed by an
 *  attestation the runtime verified. A worker states nothing, so there is nothing
 *  for it to state its way past.
 */

export type WorkerMutationDenyCode =
  | 'validation_in_progress'
  | 'read_only_role'
  | 'unattested'
  | 'incarnation_mismatch'
  | 'workspace_mismatch'

export type WorkerMutationVerdict =
  | {
      decision: 'allow'
      dispatchId: string | null
      worktreeId: string
      reason: string
    }
  | {
      decision: 'deny'
      code: 'validation_in_progress'
      dispatchId: string | null
      worktreeId: string
      lease: ValidationLease
      remedies: readonly string[]
      reason: string
    }
  | {
      decision: 'deny'
      code: Exclude<WorkerMutationDenyCode, 'validation_in_progress'>
      dispatchId: string | null
      worktreeId: string | null
      reason: string
    }

/** The session as the RUNTIME established it, never as a caller described it.
 *
 *  Every field is one the runtime resolves for itself: the terminal handle and
 *  pane key come from the attested hook/RPC envelope, the process incarnation
 *  identifies the exact provider session occupying that pane, and the worktree is
 *  resolved from the terminal rather than read off the request. A worker that
 *  could state any of these could borrow the identity of a session that is
 *  allowed to write. */
export type AttestedSession = {
  terminalHandle: string | null | undefined
  paneKey: string | null | undefined
  /** The exact provider session in that pane, as the runtime observed it.
   *  Required: a pane key is a location and outlives the process in it, so
   *  without the incarnation a restarted or replaced session inherits the
   *  previous one's answer. */
  processIncarnation: string | null | undefined
  /** The workspace that terminal actually occupies, resolved by the runtime. */
  worktreeId: string | null | undefined
}

function deny(
  code: Exclude<WorkerMutationDenyCode, 'validation_in_progress'>,
  reason: string,
  dispatchId: string | null = null,
  worktreeId: string | null = null
): WorkerMutationVerdict {
  return { decision: 'deny', code, dispatchId, worktreeId, reason }
}

export function resolveWorkerMutationVerdict(args: {
  db: OrchestrationDb
  session: AttestedSession
  nowMs: number
}): WorkerMutationVerdict {
  const { terminalHandle, paneKey, worktreeId, processIncarnation } = args.session
  if (!terminalHandle || !paneKey || !worktreeId) {
    // Fail closed: an unattested caller has no workspace the runtime can name,
    // so there is nothing to check a lease against.
    return deny(
      'unattested',
      'This request did not come from a session Orca attested, so the workspace it would mutate cannot be established.'
    )
  }
  // Why the Dispatch is looked up and not required: a lease protects the
  // WORKSPACE. An operator pane and a supervised worker in the same worktree are
  // equally able to contaminate a running gate, and only the holder is exempt.
  const dispatch = args.db.getActiveDispatchForIdentity(terminalHandle, paneKey)
  const dispatchId = dispatch?.id ?? null
  if (dispatch && (!processIncarnation || !dispatch.process_incarnation)) {
    // Missing is not exempt. A pane key outlives the process in it, so an
    // unidentified session in a supervised pane is precisely the case where the
    // previous Dispatch's answer must not be reused.
    return deny(
      'incarnation_mismatch',
      `Dispatch ${dispatch.id} occupies pane ${paneKey}, but the provider session in it cannot be identified, so its answer cannot be reused.`,
      dispatchId,
      worktreeId
    )
  }
  if (dispatch && dispatch.process_incarnation !== processIncarnation) {
    return deny(
      'incarnation_mismatch',
      `Pane ${paneKey} is occupied by a different provider session than Dispatch ${dispatch.id} was launched as, so its answer cannot be reused.`,
      dispatchId,
      worktreeId
    )
  }
  if (dispatch) {
    const placed = args.db.getWorkerDispatch(dispatch.id)?.worktree_id
    if (placed && placed !== worktreeId) {
      // The Dispatch record and the live terminal disagree about where this work
      // is. Neither can be preferred, so neither is trusted.
      return deny(
        'workspace_mismatch',
        `Dispatch ${dispatch.id} is recorded in ${placed} but its terminal reports ${worktreeId}; the runtime cannot say which workspace this mutation lands in.`,
        dispatchId,
        worktreeId
      )
    }
  }
  // A reviewer reads; it does not write. Its authority to mutate does not
  // depend on whether a gate happens to be running: reviewing the tree it is
  // also editing is the separation founder guarantee 5 exists to keep, and an
  // idle moment between gates is not permission.
  if (dispatch && isReadOnlyPhaseKind(readDispatchPhaseKind(args.db, dispatch.id))) {
    return deny(
      'read_only_role',
      `Dispatch ${dispatch.id} is executing a review phase, which may read this workspace but never mutate it.`,
      dispatchId,
      worktreeId
    )
  }

  // No holder exemption. Owning a lease is authority to RELEASE it, never
  // authority to mutate under it: the builder that took the lease is the one
  // whose gate child process is reading the tree right now, so its own model
  // editing that tree is the contamination the lease exists to prevent.
  const guard = assertMutationAllowed(new ControlPlaneStore(args.db), {
    scopeKey: validationScopeKeyForWorktree(worktreeId),
    nowMs: args.nowMs
  })
  if (guard.allowed) {
    return {
      decision: 'allow',
      dispatchId,
      worktreeId,
      reason: 'No other validation lease is active on this workspace.'
    }
  }
  return {
    decision: 'deny',
    code: guard.code,
    dispatchId,
    worktreeId,
    lease: guard.lease,
    remedies: guard.remedies,
    reason: guard.reason
  }
}
