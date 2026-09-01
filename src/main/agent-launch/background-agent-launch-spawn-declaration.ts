// Host handler for the ids-free background DECLARATION on a pty:spawn agentLaunch
// request (U6; ledger #8/#13). The client NEVER sends a LaunchIntent or an
// attemptId — it only declares `unattended: {kind:'background'}`; the HOST mints
// the attemptId, creates the generic background attempt BEFORE resolution, builds
// its own LaunchIntent {kind:'background', attemptId, worktreeId}, and settles or
// rolls the attempt back with the spawn outcome, returning the attemptId in-band
// so a future renderer producer can correlate it to its worktree deep link.
//
// There is NO production sender in U6 (ruling #13): launchAgentBackgroundSession
// is automation-owned and github-background is WorktreeMeta-owned, so no genuine
// ownerless background surface exists yet and none is synthesized. The first real
// sender (a U9 deep-link launch) reuses this handler unchanged. Pure and
// injectable; the pty:spawn caller owns the resolver call and the PTY spawn.

import type { LaunchIntent } from '../../shared/agent-launch-host-contract'
import type {
  AgentLaunchFailure,
  PersistedAgentLaunchFailure
} from '../../shared/agent-launch-contract'
import type { TuiAgent } from '../../shared/types'
import type { AgentLaunchSpawnResolution } from './agent-launch-spawn'
import type { BackgroundAgentLaunchCreateInput } from './background-agent-launch-store'

export type BackgroundDeclarationDeps = {
  /** Create the attempt in the generic background store (before resolution). */
  createAttempt: (input: BackgroundAgentLaunchCreateInput) => void
  /** Settle a launched attempt at the registration event. */
  settleLaunched: (attemptId: string) => void
  /** Record a durable `failed` attempt (a resolution failure that is neither a
   *  request error nor a pre-attempt capacity rejection). */
  settleFailed: (attemptId: string, failure: PersistedAgentLaunchFailure) => void
  /** Drop the attempt entirely — used for a request error or capacity rejection
   *  so neither ever enters attempt history. */
  rollback: (attemptId: string) => void
  mintAttemptId: () => string
  mintOperationId: () => string
  mintFailureId: () => string
  now?: () => number
}

export type BackgroundDeclarationLaunch = {
  attemptId: string
  intent: Extract<LaunchIntent, { kind: 'background' }>
  /** The op-store/idempotency scope for this launch is the attempt id, never the
   *  worktree — a worktree may host several unattended attempts at once. */
  scope: string
}

/** Create the generic background attempt BEFORE resolution and hand back the
 *  host-minted intent + scope for the resolver. `requestedAgent` is the client's
 *  declared selection identity, preserved verbatim (a stale custom id keeps the
 *  requested-vs-fallback distinction, so its failed attempt names the right id and
 *  survives reload). `baseAgent` is unknown until resolution, so it starts null. */
export function beginBackgroundDeclarationLaunch(
  deps: BackgroundDeclarationDeps,
  input: { worktreeId: string; requestedAgent: TuiAgent }
): BackgroundDeclarationLaunch {
  const attemptId = deps.mintAttemptId()
  deps.createAttempt({
    attemptId,
    worktreeId: input.worktreeId,
    operationId: deps.mintOperationId(),
    requestedAgent: input.requestedAgent,
    baseAgent: null
  })
  return {
    attemptId,
    intent: { kind: 'background', attemptId, worktreeId: input.worktreeId },
    scope: attemptId
  }
}

export type BackgroundDeclarationResolutionOutcome = {
  /** True only for a successful resolution — the caller proceeds to spawn and the
   *  spawn/registration seam settles the still-`pending` attempt. */
  proceed: boolean
  /** True when the attempt is retained (settled `failed`); false when it was
   *  rolled back. Drives whether the caller echoes `backgroundAttemptId`. */
  attemptRetained: boolean
}

/** Settle the attempt from the PRE-SPAWN resolution outcome. A request error or a
 *  pre-attempt capacity rejection rolls the attempt back (§U6: request errors and
 *  capacity rejection stay out of attempt history — "admission rejection creates
 *  no generic attempt"). Any other resolution failure records a durable `failed`
 *  attempt that survives reload (oracle 11). A success leaves the attempt
 *  `pending` for the spawn/registration seam. */
export function settleBackgroundDeclarationResolution(
  deps: BackgroundDeclarationDeps,
  attemptId: string,
  resolution: AgentLaunchSpawnResolution
): BackgroundDeclarationResolutionOutcome {
  if (resolution.ok) {
    return { proceed: true, attemptRetained: true }
  }
  if ('requestError' in resolution) {
    deps.rollback(attemptId)
    return { proceed: false, attemptRetained: false }
  }
  if (resolution.failure.code === 'launch_capacity_exceeded') {
    deps.rollback(attemptId)
    return { proceed: false, attemptRetained: false }
  }
  deps.settleFailed(attemptId, persistBackgroundFailure(deps, resolution.failure))
  return { proceed: false, attemptRetained: true }
}

/** Wrap a bare AgentLaunchFailure in the host-minted persisted envelope. The
 *  intent is always `background` here — this handler only ever mints one kind. */
export function persistBackgroundFailure(
  deps: BackgroundDeclarationDeps,
  failure: AgentLaunchFailure
): PersistedAgentLaunchFailure {
  const nowFn = deps.now ?? Date.now
  return {
    ...failure,
    version: 1,
    failureId: deps.mintFailureId(),
    intent: 'background',
    occurredAt: nowFn()
  }
}

/** Settle the `pending` attempt from the SPAWN outcome (a provider event):
 *  registration → `launched`; a spawn/registration throw → durable `failed`
 *  (`spawn_failed`). Called from the caller's shared launch/settle seam. */
export function settleBackgroundDeclarationSpawn(
  deps: BackgroundDeclarationDeps,
  launch: BackgroundDeclarationLaunch,
  settlement: 'registered' | 'failed',
  requestedAgent: TuiAgent
): void {
  if (settlement === 'registered') {
    deps.settleLaunched(launch.attemptId)
    return
  }
  deps.settleFailed(
    launch.attemptId,
    persistBackgroundFailure(deps, { code: 'spawn_failed', requestedAgent })
  )
}
