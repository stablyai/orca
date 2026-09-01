// Builds the ReconcileAgentLaunchDeps the runtime drives from injected host
// primitives (U6). Keeps the liveness-resolution + owner-routing wiring pure and
// electron-free so it is unit-testable away from the 20k-line runtime; the
// runtime supplies the concrete token probe, host-authority predicate, and owner
// writers.
//
// Liveness follows the plan's reconciliation contract (487-513) exactly:
//   - A launch token matched to a live terminal → `live`; `attributed` is whether
//     that terminal still belongs to the launch's worktree (an unattributed live
//     token is the pane-identity-theft class → invalid_launch_snapshot).
//   - No live token match → `absent` ONLY when the pending's execution host is
//     currently authoritatively listable (local in-process terminals died with
//     main; a reconnected provider just re-listed its terminals). Otherwise the
//     host is a possibly-unreachable survivor → `unknown` (non-retryable, durable)
//     until its own terminal-list/reconnect event re-probes. `isHostAuthoritative`
//     encodes which hosts a given reconcile pass can speak for, so a daemon/SSH
//     survivor is never falsely settled `absent` before its provider reconnects.
//   - Listing authority is ANDed with TOKEN authority: a peer that predates the
//     launch-token echo (pre-v34 daemon, old SSH relay) accepts the token on
//     create and silently drops it, so its listing can NEVER carry one. Reading
//     that missing echo as absence settles spawn_failed for a live agent and the
//     user's Retry then spawns a duplicate beside it. Such hosts fall back to the
//     pre-launchToken identification, and hold the launch pending when that is
//     inconclusive.
//
// KNOWN GAP (pre-existing, out of custom-agent scope): token authority is read
// per-host here, but the SSH path withholds the token per-launch on a mutable
// probe that also collapses timeouts into `false` — so a recovered probe can read
// a live launch's missing echo as absence. Needs the delivery fact pinned at
// dispatch; always sending the token does not fix it (old relays drop it).

import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import {
  parseExecutionHostId,
  RUNTIME_OWNED_SSH_TARGET_ID_PREFIX
} from '../../shared/execution-host'
import type {
  AgentLaunchOperationStore,
  PendingAgentLaunchSnapshot
} from './agent-launch-operation-store'
import {
  reconcilePersistenceForIntent,
  type ReconcileIntentRouterArms
} from './agent-launch-reconcile-intent-router'
import type {
  ReconcileAgentLaunchDeps,
  ResolvedLaunchLiveness
} from './agent-launch-worktree-reconcile-writer'

/** A live terminal a launch token currently maps to. `worktreeId` is compared to
 *  the launch's expected worktree for attribution; null means the re-list saw
 *  the session but could not resolve its worktree (e.g. an SSH session whose
 *  cwd/persisted binding no longer maps) — the token match alone still proves
 *  the launch's own terminal is alive, so it must never resolve `absent`. */
export type LiveTerminalForToken = { ptyId: string; worktreeId: string | null }

/** Verdict of the pre-launchToken identification used for hosts that cannot echo
 *  tokens: `absent` only when the re-listed terminals PROVE the launch's terminal
 *  is gone. Anything less is `inconclusive` and holds the launch pending. */
export type TokenlessLaunchLiveness = 'absent' | 'inconclusive'

export type ReconcileRuntimeDeps = {
  operationStore: AgentLaunchOperationStore
  /** The live terminal holding a launch token, or null if none is live. */
  liveTerminalByToken: (launchToken: string) => LiveTerminalForToken | null
  /** Whether a non-live pending's host can be spoken for authoritatively in this
   *  reconcile pass (→ `absent`); false leaves it `unknown`. */
  isHostAuthoritative: (executionHostId: AgentLaunchExecutionHostId) => boolean
  /** Whether a MISSING launchToken in this host's listing is absence proof. False
   *  for peers that predate the echo and drop the token they were handed. */
  isHostTokenAuthoritative: (executionHostId: AgentLaunchExecutionHostId) => boolean
  /** Pre-launchToken identification, consulted only for non-token-authoritative
   *  hosts. Omitted (or `inconclusive`) holds the launch pending. */
  identifyLaunchWithoutTokenEcho?: (pending: PendingAgentLaunchSnapshot) => TokenlessLaunchLiveness
  /** The worktree a live token must belong to for attribution: the scope for a
   *  worktree launch, the attempt's worktree for a background launch, or null when
   *  the intent has no worktree to compare (attribution then trusts the token). */
  expectedWorktreeId: (pending: PendingAgentLaunchSnapshot) => string | null
  arms: ReconcileIntentRouterArms
  settleBoundary: (launchToken: string, settlement: 'registered' | 'failed') => void
  mintFailureId: () => string
  now?: () => number
}

/** Host authority for one controller re-list pass. Local and WSL terminals
 *  execute on this machine (in-process ones died with main; daemon ones were
 *  just re-listed), so a successful full list always speaks for them. A remote
 *  ssh/runtime host is authoritative ONLY when its relay connection contributed
 *  at least one session to that same successful list — the reconnected+re-listed
 *  proof the liveness rules above require — so a disconnected or merely-quiet
 *  remote survivor stays `unknown` instead of being falsely settled absent. */
export function hostAuthorityFromRelistedConnections(
  relistedConnectionIds: ReadonlySet<string>
): (hostId: AgentLaunchExecutionHostId) => boolean {
  return (hostId) => {
    if (hostId === 'local' || hostId.startsWith('wsl:')) {
      return true
    }
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'ssh') {
      return relistedConnectionIds.has(parsed.targetId)
    }
    if (parsed?.kind === 'runtime') {
      // Runtime envs are reached over their runtime-owned SSH target; same
      // prefix rule as getRuntimeOwnedSshTargetId (kept in sync via the shared
      // constant).
      return relistedConnectionIds.has(
        `${RUNTIME_OWNED_SSH_TARGET_ID_PREFIX}${parsed.environmentId}`
      )
    }
    return false
  }
}

function resolveLiveness(
  deps: ReconcileRuntimeDeps,
  pending: PendingAgentLaunchSnapshot
): ResolvedLaunchLiveness {
  const live = deps.liveTerminalByToken(pending.launchToken)
  if (live) {
    const expected = deps.expectedWorktreeId(pending)
    return {
      kind: 'live',
      // A null live worktree is "unresolvable", not "different": the token is
      // a per-launch random secret, so its match is proof of identity, and
      // unattributed (identity theft) requires evidence of a CONFLICTING owner.
      attributed: expected === null || live.worktreeId === null || live.worktreeId === expected,
      terminalId: live.ptyId
    }
  }
  const host = pending.snapshot.target.executionHostId
  if (!deps.isHostAuthoritative(host)) {
    return { kind: 'unknown' }
  }
  if (!deps.isHostTokenAuthoritative(host)) {
    // A peer that never echoes tokens can only be identified the pre-token way;
    // absent needs positive proof there, or Retry duplicates a running agent.
    return deps.identifyLaunchWithoutTokenEcho?.(pending) === 'absent'
      ? { kind: 'absent' }
      : { kind: 'unknown' }
  }
  return { kind: 'absent' }
}

export function buildReconcileAgentLaunchDeps(
  deps: ReconcileRuntimeDeps
): ReconcileAgentLaunchDeps {
  return {
    operationStore: deps.operationStore,
    resolveLiveness: (pending) => resolveLiveness(deps, pending),
    persistenceFor: (pending) => reconcilePersistenceForIntent(deps.arms, pending),
    settleBoundary: deps.settleBoundary,
    mintFailureId: deps.mintFailureId,
    now: deps.now
  }
}
