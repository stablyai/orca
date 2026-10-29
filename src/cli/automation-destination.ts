// Capture the authority's SSH generation so it can reject removed or re-registered targets at write time.

import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../shared/automation-owner-conflict'
import type { AutomationDestination } from '../shared/automation-owner-precondition'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { SshTargetSummary } from '../shared/ssh-types'
import type { Repo } from '../shared/repo-types'
import type { RuntimeClient } from './runtime-client'
import { fetchSshTargetSummaries } from './host-selector-alternatives'

/** Empty selectors mean the execution host cannot change. */
export type AutomationDestinationTarget = { repo?: string; workspace?: string }

async function resolveTargetRepo(
  client: RuntimeClient,
  target: AutomationDestinationTarget
): Promise<Repo> {
  if (target.repo) {
    return (await client.call<{ repo: Repo }>('repo.show', { repo: target.repo })).result.repo
  }
  const worktree = (
    await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: target.workspace
    })
  ).result.worktree
  return (await client.call<{ repo: Repo }>('repo.show', { repo: `id:${worktree.repoId}` })).result
    .repo
}

// A registered target without a generation needs no fence; an unregistered target is gone.
async function sshTargetGeneration(
  client: RuntimeClient,
  targetId: string
): Promise<number | undefined> {
  const { targets } = await fetchSshTargetSummaries<SshTargetSummary>(client)
  const match = targets.find((candidate) => candidate.id === targetId)
  if (!match) {
    throw new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination)
  }
  return match.generation
}

export async function resolveAutomationDestination(
  client: RuntimeClient,
  target: AutomationDestinationTarget
): Promise<AutomationDestination | undefined> {
  if (!target.repo && !target.workspace) {
    return undefined
  }
  const repo = await resolveTargetRepo(client, target)
  const connectionId = repo.connectionId?.trim()
  if (!connectionId) {
    return { selector: { kind: 'self' } }
  }
  const generation = await sshTargetGeneration(client, connectionId)
  return generation === undefined
    ? undefined
    : { selector: { kind: 'ssh', targetId: connectionId, targetGeneration: generation } }
}
