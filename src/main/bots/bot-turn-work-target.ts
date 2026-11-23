import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../runtime/orchestration/addressing/orchestration-caller-identity'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

/** In-memory active-turn placement binding for a bot chat's single targeted message. */
export class BotTurnWorkTargetRegistry {
  private readonly activeBySession = new Map<string, ResolvedBotWorkTargetPlacement>()

  setForTurn(sessionId: string, placement: ResolvedBotWorkTargetPlacement | null): void {
    if (placement) {
      this.activeBySession.set(sessionId, placement)
    } else {
      this.activeBySession.delete(sessionId)
    }
  }

  getForTurn(sessionId: string): ResolvedBotWorkTargetPlacement | undefined {
    return this.activeBySession.get(sessionId)
  }

  clearForTurn(sessionId: string): void {
    this.activeBySession.delete(sessionId)
  }
}

export type WorkerStartPlacementParams = {
  repo?: string
  worktree?: string
  on?: string
  terminal?: string
}

export type ResolvedWorkerStartWorkTarget<T extends WorkerStartPlacementParams> = {
  params: T
  /** Validated placement identity to enforce at launch (host, occupant instance, pairing fence, lineage). */
  enforcement?: ResolvedBotWorkTargetPlacement
}

function matchesPlacementHost(
  on: string | undefined,
  placement: ResolvedBotWorkTargetPlacement
): boolean {
  if (!placement.onEnvironmentId) {
    return !on
  }
  if (!on) {
    return false
  }
  return on === placement.onEnvironmentId || on === placement.canonicalTarget.hostLabel
}

function matchesPlacementRepo(
  repo: string | undefined,
  placement: ResolvedBotWorkTargetPlacement
): boolean {
  if (!repo) {
    return true
  }
  return repo === placement.repoSelector || repo === placement.canonicalTarget.repoId
}

function matchesPlacementWorktree(
  worktree: string | undefined,
  placement: ResolvedBotWorkTargetPlacement
): boolean {
  if (!worktree || worktree === 'current') {
    return true
  }
  if (placement.mode === 'new-top-level') {
    return worktree === 'new-top-level'
  }
  const canonicalId = placement.canonicalTarget.workspaceId
  return (
    worktree === placement.worktreeSelector ||
    (canonicalId !== undefined && (worktree === `id:${canonicalId}` || worktree === canonicalId))
  )
}

/**
 * Apply or bind the active turn's validated work target to `worker-start` params while preserving
 * exact host, repo, workspace occupant instance, and paired-server pairing revision all the way to launch.
 */
export function resolveBotTurnWorkTargetToWorkerStart<T extends WorkerStartPlacementParams>(
  params: T,
  placement: ResolvedBotWorkTargetPlacement | undefined,
  isFollowUp: boolean
): ResolvedWorkerStartWorkTarget<T> {
  if (!placement || isFollowUp || params.terminal) {
    return { params }
  }
  const hasExplicitRepo = Boolean(params.repo)
  const hasExplicitHost = Boolean(params.on)
  const hasExplicitWorktree = Boolean(params.worktree && params.worktree !== 'current')
  const omittedExplicitTarget = !hasExplicitRepo && !hasExplicitHost && !hasExplicitWorktree

  if (omittedExplicitTarget) {
    if (placement.mode === 'new-top-level' && placement.repoSelector) {
      return {
        params: {
          ...params,
          repo: placement.repoSelector,
          worktree: 'new-top-level',
          ...(placement.onEnvironmentId ? { on: placement.onEnvironmentId } : {})
        },
        enforcement: placement
      }
    }
    if (placement.mode === 'existing' && placement.worktreeSelector) {
      return {
        params: {
          ...params,
          worktree: placement.worktreeSelector,
          ...(placement.onEnvironmentId ? { on: placement.onEnvironmentId } : {})
        },
        enforcement: placement
      }
    }
    return { params }
  }

  // When the bot follows `<orca_context>` and passes matching explicit flags, keep enforcement pinned.
  if (!matchesPlacementHost(params.on, placement)) {
    return { params }
  }
  if (
    placement.mode === 'new-top-level' &&
    placement.repoSelector &&
    matchesPlacementRepo(params.repo, placement) &&
    matchesPlacementWorktree(params.worktree, placement)
  ) {
    return {
      params: {
        ...params,
        repo: placement.repoSelector,
        worktree: 'new-top-level',
        ...(placement.onEnvironmentId ? { on: placement.onEnvironmentId } : {})
      },
      enforcement: placement
    }
  }
  if (
    placement.mode === 'existing' &&
    placement.worktreeSelector &&
    !hasExplicitRepo &&
    matchesPlacementWorktree(params.worktree, placement)
  ) {
    return {
      params: {
        ...params,
        worktree: placement.worktreeSelector,
        ...(placement.onEnvironmentId ? { on: placement.onEnvironmentId } : {})
      },
      enforcement: placement
    }
  }
  return { params }
}

/**
 * When a bot invokes `worker-start` during a targeted turn without naming an explicit repo/worktree/host,
 * apply the turn's validated target instead of letting default `--worktree current` leak into the bot home.
 */
export function applyBotTurnWorkTargetToWorkerStart<T extends WorkerStartPlacementParams>(
  params: T,
  placement: ResolvedBotWorkTargetPlacement | undefined,
  isFollowUp: boolean
): T {
  return resolveBotTurnWorkTargetToWorkerStart(params, placement, isFollowUp).params
}

/** Resolve any active turn target for `caller`, returning rewritten params and launch enforcement. */
export function resolveBotTurnWorkTargetForCaller<T extends WorkerStartPlacementParams>(
  params: T,
  registry: BotTurnWorkTargetRegistry | undefined,
  caller: OrchestrationEntryCaller | undefined,
  isFollowUp: boolean
): ResolvedWorkerStartWorkTarget<T> {
  const session = sessionCallerOf(caller)
  return resolveBotTurnWorkTargetToWorkerStart(
    params,
    session ? registry?.getForTurn(session.sessionId) : undefined,
    isFollowUp
  )
}

/** Resolve any active turn target for `caller` and apply it to `worker-start` params. */
export function applyBotTurnWorkTargetForCaller<T extends WorkerStartPlacementParams>(
  params: T,
  registry: BotTurnWorkTargetRegistry | undefined,
  caller: OrchestrationEntryCaller | undefined,
  isFollowUp: boolean
): T {
  return resolveBotTurnWorkTargetForCaller(params, registry, caller, isFollowUp).params
}

/** Apply any active bot turn work target to raw RPC worker-start values before remote-owned routing. */
export function resolveWorkerStartWorkTargetValues(
  values: Record<string, unknown>,
  registry: BotTurnWorkTargetRegistry | undefined,
  caller: OrchestrationEntryCaller | undefined
): { values: Record<string, unknown>; workTarget?: ResolvedBotWorkTargetPlacement } {
  if (
    values.retryOf !== undefined ||
    values.terminal !== undefined ||
    values.origin !== undefined
  ) {
    return { values }
  }
  const readStr = (key: string): string | undefined => {
    const value = values[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const resolved = resolveBotTurnWorkTargetForCaller(
    { repo: readStr('repo'), worktree: readStr('worktree'), on: readStr('on') },
    registry,
    caller,
    false
  )
  if (!resolved.enforcement) {
    return { values }
  }
  return {
    workTarget: resolved.enforcement,
    values: {
      ...values,
      ...(resolved.params.repo !== undefined ? { repo: resolved.params.repo } : {}),
      ...(resolved.params.worktree !== undefined ? { worktree: resolved.params.worktree } : {}),
      ...(resolved.params.on !== undefined ? { on: resolved.params.on } : {})
    }
  }
}

/** Reject a paired-server launch if the pairing changed after the turn work target was validated. */
export function assertBotWorkTargetPairingRevision(
  server: { name: string; pairingRevision?: number; peerFingerprint?: string },
  workTarget: ResolvedBotWorkTargetPlacement | undefined
): void {
  if (!workTarget?.onEnvironmentId) {
    return
  }
  const revisionMismatch =
    workTarget.onExpectedPairingRevision !== undefined &&
    server.pairingRevision !== workTarget.onExpectedPairingRevision
  const fingerprintMismatch =
    workTarget.onExpectedPeerFingerprint !== undefined &&
    server.peerFingerprint !== workTarget.onExpectedPeerFingerprint
  if (revisionMismatch || fingerprintMismatch) {
    throw new OrchestrationError(
      'server_pairing_changed',
      `The pairing with ${server.name} changed after the selected target was validated. No effects were applied.`,
      { effectsApplied: false, server: server.name }
    )
  }
}
