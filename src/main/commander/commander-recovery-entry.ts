import { createHash } from 'node:crypto'
import {
  encodeHandoffBody,
  HANDOFF_GOAL_LIMIT,
  HANDOFF_SECTION_LIMIT
} from '../../shared/commander/goal-handoff'
import type { CommanderMemoryRevision } from '../../shared/commander/memory-contract'
import type { RecoveryObservation } from './commander-recovery-observation'

export const recoveryActorId = 'orca-recovery'
export type RecoveryEntry = { pageId: string; projectId: string; title: string; body: string }

function bounded(text: string, limit: number): string {
  return text
    .trim()
    .slice(0, limit)
    .replace(/[\uD800-\uDBFF]$/, '')
}

export function recoveryEntry(
  observation: RecoveryObservation,
  generation: string,
  initialGoal = observation.goal
): RecoveryEntry {
  const {
    projectId,
    sessionId,
    goal,
    progress,
    nextStep,
    branch,
    head,
    dirty,
    provider,
    state,
    outcome,
    at
  } = observation
  const hex = createHash('sha256')
    .update(JSON.stringify([generation, projectId, sessionId]))
    .digest('hex')
  const pageId = `handoff-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  const git = [
    `Source agent: ${provider}`,
    `Turn: ${state}${outcome ? ` (${outcome})` : ''} · ${new Date(at).toISOString()}`,
    `Branch: ${branch ?? 'unknown or detached'}`,
    `Commit: ${head ?? 'unknown'}`,
    `Working tree at observation: ${dirty === null ? 'unknown' : dirty ? 'local changes present; files remain on source host' : 'clean'}`
  ]
  return {
    pageId,
    projectId,
    title: bounded(initialGoal, HANDOFF_GOAL_LIMIT),
    body: encodeHandoffBody({
      progress: [bounded(progress, 2400), `Latest request: ${bounded(goal, 240)}`, ...git]
        .join('\n\n')
        .slice(0, HANDOFF_SECTION_LIMIT),
      nextStep: bounded(nextStep, HANDOFF_SECTION_LIMIT)
    })
  }
}

export function canUpdateRecovery(page: CommanderMemoryRevision, entry: RecoveryEntry): boolean {
  return (
    !page.deleted &&
    page.kind === 'note' &&
    page.projectId === entry.projectId &&
    [page.actor, page.createdBy].every(
      (actor) => actor.type === 'commander' && actor.id === recoveryActorId
    )
  )
}
