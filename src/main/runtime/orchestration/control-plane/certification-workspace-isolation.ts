import { realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { OrchestrationError } from '../orchestration-error'

/** Correction — a certification worker may never be placed in the checkout the
 *  work is being implemented in.
 *
 *  What happened: certification workers were dispatched into the Package B
 *  implementation worktree. Their candidate runtime, state root, database and
 *  socket were all isolated; the GIT WORKSPACE was not. Two of them committed to
 *  the source branch and destroyed the principal's uncommitted work. Isolating
 *  the runtime and calling the worker isolated was the whole mistake: a worker
 *  writes through its shell, not through the runtime.
 *
 *  So placement is the fence. A certification Dispatch must name a disposable
 *  workspace — one created for the run and thrown away with it — and naming the
 *  coordinator's own checkout is refused at mint time, before any worker exists.
 */

/** Worktree ids are `<repoId>::<absolutePath>`. The path is the identity that
 *  matters: the same directory registered under two repo ids is still one set of
 *  files, and comparing the ids would call that two workspaces. */
export function worktreePathOf(worktreeId: string): string {
  const separator = worktreeId.indexOf('::')
  return separator === -1 ? worktreeId : worktreeId.slice(separator + 2)
}

/** Resolves symlinks and path spelling so `/tmp/x`, `/private/tmp/x` and
 *  `/tmp/./x` cannot read as three workspaces. Returns null when the path cannot
 *  be resolved at all, which is a refusal below rather than a pass. */
function canonicalWorkspacePath(worktreeId: string): string | null {
  const path = worktreePathOf(worktreeId)
  if (!path) {
    return null
  }
  try {
    return realpathSync(resolve(path))
  } catch {
    return null
  }
}

/** True when `inner` IS `outer` or lives inside it. Nested checkouts share
 *  files, so a worker placed one directory down still writes the implementation
 *  tree — inequality of two strings never proved disjoint placement. */
function containsOrEquals(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'))
}

export function isSameWorkspace(left: string, right: string): boolean {
  const leftPath = canonicalWorkspacePath(left)
  const rightPath = canonicalWorkspacePath(right)
  if (!leftPath || !rightPath) {
    // Unresolvable is not "different". Callers that need a verdict must refuse.
    return true
  }
  return containsOrEquals(leftPath, rightPath) || containsOrEquals(rightPath, leftPath)
}

/** A Dispatch the runtime believes is still running in a workspace. Passed in
 *  rather than queried so this stays a pure decision the tests can drive. */
export type WorkspaceOccupant = {
  dispatchId: string
  status: string
  terminalHandle: string | null
  /** The agent occupying it, so coverage can ask whether that route can actually
   *  be stopped before it mutates. Absent means unknown, which is not blocking. */
  agent?: string | null
}

/** Throws unless a certification launch is provably placed OUTSIDE the
 *  coordinator's own implementation checkout.
 *
 *  Why at mint and not at launch: the intent is the authorisation. Refusing the
 *  authorisation means no worker is ever created with that placement, so there
 *  is no window in which one exists and has to be chased down.
 *
 *  Why an unknown coordinator placement is a refusal: the only thing this guard
 *  can conclude from "I could not read where the coordinator sits" is that it
 *  cannot prove disjoint placement — and the incident is exactly what happens
 *  when unproven placement is allowed to proceed. */
export function assertDisposableCertificationWorkspace(args: {
  intentWorktreeId: string
  /** The worktree the minting coordinator itself occupies, as the runtime read
   *  it. Null when the runtime could not establish it. */
  coordinatorWorktreeId: string | null
}): void {
  const intentPath = canonicalWorkspacePath(args.intentWorktreeId)
  if (!intentPath) {
    throw new OrchestrationError(
      'certification_workspace_unprovable',
      `The runtime cannot resolve ${worktreePathOf(args.intentWorktreeId)} on disk, so it cannot prove a certification worker placed there is outside the implementation checkout.`,
      { intentWorktreeId: args.intentWorktreeId }
    )
  }
  if (!args.coordinatorWorktreeId) {
    throw new OrchestrationError(
      'certification_workspace_unprovable',
      'The runtime cannot establish which workspace this coordinator occupies, so it cannot prove the certification worker would be placed anywhere else.',
      { intentWorktreeId: args.intentWorktreeId, coordinatorWorktreeId: null }
    )
  }
  const coordinatorPath = canonicalWorkspacePath(args.coordinatorWorktreeId)
  if (!coordinatorPath) {
    throw new OrchestrationError(
      'certification_workspace_unprovable',
      `The runtime cannot resolve the coordinator's own workspace ${worktreePathOf(args.coordinatorWorktreeId)} on disk, so disjoint placement cannot be proven.`,
      {
        intentWorktreeId: args.intentWorktreeId,
        coordinatorWorktreeId: args.coordinatorWorktreeId
      }
    )
  }
  if (
    containsOrEquals(coordinatorPath, intentPath) ||
    containsOrEquals(intentPath, coordinatorPath)
  ) {
    throw new OrchestrationError(
      'certification_workspace_collision',
      `A certification worker cannot run in ${intentPath}: it is, contains, or sits inside the coordinator's own implementation checkout ${coordinatorPath}. Create a disposable workspace for the certification run and name that instead.`,
      {
        intentWorktreeId: args.intentWorktreeId,
        coordinatorWorktreeId: args.coordinatorWorktreeId,
        intentPath,
        coordinatorPath
      }
    )
  }
}

/** What a validation lease can and cannot fence.
 *
 *  The lease fence stops Orca-MANAGED mutations of a leased worktree. A worker
 *  that was already running when the lease was taken holds its own shell, and no
 *  RPC fence reaches that. Reporting the lease as protection in that state is
 *  the same class of error as reading loss of contact as process death, so the
 *  occupants are named instead of being silently assumed away.
 */
export type LeaseCoverage = {
  covered: boolean
  unfencedOccupants: readonly WorkspaceOccupant[]
  reason: string
  /** What a caller can actually do about it. Present whenever coverage fails, so
   *  an unenforceable lease is never just a boolean the caller can ignore. */
  remedies: readonly string[]
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'dispatched'])

const REMEDIES = ['use_isolated_worktree', 'wait_for_lease_completion', 'stop_the_worker'] as const

/** Whether a lease on this workspace can actually stop the workers in it.
 *
 *  A lease fences Orca-managed RPC. A worker already running mutates through its
 *  own tools, so the only thing that can stop it is its provider's synchronous
 *  pre-tool hook — and only on a route where Orca has a proven deny channel.
 *
 *  `canBlock` is injected rather than imported so this stays a pure decision and
 *  the capability table keeps exactly one owner. It defaults to "nothing can be
 *  blocked", because assuming enforceability is the failure this reports. */
export function assessLeaseCoverage(
  occupants: readonly WorkspaceOccupant[],
  canBlock: (agent: string) => boolean = () => false
): LeaseCoverage {
  const live = occupants.filter((occupant) => LIVE_STATUSES.has(occupant.status))
  if (live.length === 0) {
    return {
      covered: true,
      unfencedOccupants: [],
      reason: 'No worker is running in this workspace, so the lease fences every remaining writer.',
      remedies: []
    }
  }
  const unfenced = live.filter((occupant) => !occupant.agent || !canBlock(occupant.agent))
  if (unfenced.length === 0) {
    return {
      covered: true,
      unfencedOccupants: [],
      reason: `Every worker running here (${live.map((o) => o.dispatchId).join(', ')}) is on a route Orca can stop before it mutates.`,
      remedies: []
    }
  }
  return {
    covered: false,
    unfencedOccupants: unfenced,
    reason: `${unfenced.length} worker(s) running here cannot be stopped before they mutate (${unfenced.map((o) => `${o.dispatchId}${o.agent ? ` on ${o.agent}` : ''}`).join(', ')}); their route has no synchronous pre-tool deny channel, so a lease cannot fence them.`,
    remedies: REMEDIES
  }
}
