import {
  matchesPairedServerWorkTargetIdentity,
  sanitizeWorkTargetLabel,
  type ResolvedBotWorkTargetPlacement
} from '../../shared/agent-session/work-target/agent-session-work-target'
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
  origin?: string
}

export type ResolvedWorkerStartWorkTarget<T extends WorkerStartPlacementParams> = {
  params: T
  /** Validated placement identity to enforce at launch (host, occupant instance, pairing fence, lineage). */
  enforcement?: ResolvedBotWorkTargetPlacement
}

export function describeExpectedPlacementFlags(placement: ResolvedBotWorkTargetPlacement): string {
  const parts: string[] = []
  if (placement.onEnvironmentId) {
    parts.push(`--on ${placement.onEnvironmentId}`)
  }
  if (placement.mode === 'new-top-level' && placement.repoSelector) {
    parts.push(`--repo ${placement.repoSelector}`, '--worktree new-top-level')
  } else if (placement.worktreeSelector) {
    parts.push(`--worktree ${placement.worktreeSelector}`)
  }
  return parts.join(' ')
}

/** Resolve the host-trusted work target for a session caller or authenticated paired peer caller. */
export function activeBotWorkTargetForCaller(
  registry: BotTurnWorkTargetRegistry | undefined,
  caller: OrchestrationEntryCaller | undefined
): ResolvedBotWorkTargetPlacement | undefined {
  if (caller?.kind === 'peer') {
    return caller.workTarget
  }
  const session = sessionCallerOf(caller)
  return session ? registry?.getForTurn(session.sessionId) : undefined
}

/** Stable trusted origin label stored alongside durable message work-target provenance. */
export function workTargetProvenanceOriginForCaller(
  caller: OrchestrationEntryCaller | undefined,
  fallbackFrom: string
): string {
  if (caller?.kind === 'peer') {
    return `peer:${caller.peerRun.conversation_id}`
  }
  const session = sessionCallerOf(caller)
  return session ? `session:${session.sessionId}` : fallbackFrom
}

function workTargetConflictError(message: string): OrchestrationError {
  return new OrchestrationError('invalid_argument', `${message} No effects were applied.`, {
    effectsApplied: false
  })
}

function matchesPlacementHost(
  on: string | undefined,
  placement: ResolvedBotWorkTargetPlacement
): boolean {
  if (!placement.onEnvironmentId) {
    return !on
  }
  // Omitting `--on` on a paired-server targeted turn is completed safely from the validated placement.
  if (!on) {
    return true
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
 * Enforce the active turn's validated work target on `worker-start` params: fill compatible omitted
 * flags from `placement`, preserve matching explicit calls with full enforcement, and refuse
 * conflicting flags or unverified terminal/follow-up reuse before any side effects occur.
 */
export function resolveBotTurnWorkTargetToWorkerStart<T extends WorkerStartPlacementParams>(
  params: T,
  placement: ResolvedBotWorkTargetPlacement | undefined,
  isFollowUp: boolean
): ResolvedWorkerStartWorkTarget<T> {
  if (!placement) {
    return { params }
  }
  const label = sanitizeWorkTargetLabel(placement.canonicalTarget.displayName)
  const expectedFlags = describeExpectedPlacementFlags(placement)
  if (isFollowUp) {
    throw workTargetConflictError(
      `This turn targets "${label}". Continuing an earlier worker cannot be verified against the selected target; start a worker for the selected target with ${expectedFlags} instead.`
    )
  }
  if (params.terminal) {
    throw workTargetConflictError(
      `This turn targets "${label}". Reusing --terminal ${params.terminal} cannot be verified against the selected target; omit --terminal and run with ${expectedFlags} instead.`
    )
  }
  if (params.origin !== undefined && placement.onEnvironmentId) {
    throw workTargetConflictError(
      `This turn targets "${label}" on a paired server, which conflicts with local --item/--origin.`
    )
  }
  if (!matchesPlacementHost(params.on, placement)) {
    throw workTargetConflictError(
      `worker-start --on conflicts with this turn's selected target "${label}" (expected ${expectedFlags || 'local host'}). Omit conflicting flags or pass the exact selected target.`
    )
  }
  if (placement.mode === 'new-top-level') {
    if (!placement.repoSelector) {
      throw workTargetConflictError(
        `This turn's selected target "${label}" has no verified project selector.`
      )
    }
    if (
      !matchesPlacementRepo(params.repo, placement) ||
      !matchesPlacementWorktree(params.worktree, placement)
    ) {
      throw workTargetConflictError(
        `worker-start flags conflict with this turn's selected target "${label}" (expected ${expectedFlags}). Omit conflicting flags or pass the exact selected target.`
      )
    }
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
  if (!placement.worktreeSelector) {
    throw workTargetConflictError(
      `This turn's selected target "${label}" has no verified workspace selector.`
    )
  }
  if (params.repo || !matchesPlacementWorktree(params.worktree, placement)) {
    throw workTargetConflictError(
      `worker-start flags conflict with this turn's selected target "${label}" (expected ${expectedFlags}). Omit conflicting flags or pass the exact selected target.`
    )
  }
  return {
    params: {
      ...params,
      worktree: placement.worktreeSelector,
      ...(placement.onEnvironmentId ? { on: placement.onEnvironmentId } : {})
    },
    enforcement: placement
  }
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
  return resolveBotTurnWorkTargetToWorkerStart(
    params,
    activeBotWorkTargetForCaller(registry, caller),
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

/** Enforce any active bot turn work target on raw RPC worker-start values before remote-owned routing. */
export function resolveWorkerStartWorkTargetValues(
  values: Record<string, unknown>,
  registry: BotTurnWorkTargetRegistry | undefined,
  caller: OrchestrationEntryCaller | undefined
): { values: Record<string, unknown>; workTarget?: ResolvedBotWorkTargetPlacement } {
  const readStr = (key: string): string | undefined => {
    const value = values[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const resolved = resolveBotTurnWorkTargetForCaller(
    {
      repo: readStr('repo'),
      worktree: readStr('worktree'),
      on: readStr('on'),
      terminal: readStr('terminal'),
      origin: readStr('origin')
    },
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
  server: {
    environmentId?: string
    name: string
    pairingRevision?: number
    peerFingerprint?: string
  },
  workTarget: ResolvedBotWorkTargetPlacement | undefined
): void {
  if (!workTarget?.onEnvironmentId) {
    return
  }
  if (
    !matchesPairedServerWorkTargetIdentity(server, {
      environmentId: workTarget.onEnvironmentId,
      pairingRevision: workTarget.onExpectedPairingRevision,
      peerFingerprint: workTarget.onExpectedPeerFingerprint
    })
  ) {
    throw new OrchestrationError(
      'server_pairing_changed',
      `The pairing with ${server.name} changed after the selected target was validated. No effects were applied.`,
      { effectsApplied: false, server: server.name }
    )
  }
}
