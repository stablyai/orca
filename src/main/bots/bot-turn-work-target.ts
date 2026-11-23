import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../runtime/orchestration/addressing/orchestration-caller-identity'

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

/**
 * When a bot invokes `worker-start` during a targeted turn without naming an explicit repo/worktree/host,
 * apply the turn's validated target instead of letting default `--worktree current` leak into the bot home.
 */
export function applyBotTurnWorkTargetToWorkerStart<T extends WorkerStartPlacementParams>(
  params: T,
  placement: ResolvedBotWorkTargetPlacement | undefined,
  isFollowUp: boolean
): T {
  if (!placement || isFollowUp || params.terminal) {
    return params
  }
  const hasExplicitRepo = Boolean(params.repo)
  const hasExplicitHost = Boolean(params.on)
  const hasExplicitWorktree = Boolean(params.worktree && params.worktree !== 'current')
  if (hasExplicitRepo || hasExplicitHost || hasExplicitWorktree) {
    return params
  }
  if (placement.mode === 'new-child' && placement.repoSelector) {
    return {
      ...params,
      repo: placement.repoSelector,
      worktree: 'new-child',
      ...(placement.onEnvironmentId ? { on: placement.onEnvironmentId } : {})
    }
  }
  if (placement.mode === 'existing' && placement.worktreeSelector) {
    return {
      ...params,
      worktree: placement.worktreeSelector,
      ...(placement.onEnvironmentId ? { on: placement.onEnvironmentId } : {})
    }
  }
  return params
}

/** Resolve any active turn target for `caller` and apply it to `worker-start` params. */
export function applyBotTurnWorkTargetForCaller<T extends WorkerStartPlacementParams>(
  params: T,
  registry: BotTurnWorkTargetRegistry | undefined,
  caller: OrchestrationEntryCaller | undefined,
  isFollowUp: boolean
): T {
  const session = sessionCallerOf(caller)
  return applyBotTurnWorkTargetToWorkerStart(
    params,
    session ? registry?.getForTurn(session.sessionId) : undefined,
    isFollowUp
  )
}
