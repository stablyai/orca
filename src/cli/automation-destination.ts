/**
 * Where a CLI create — or an edit that moves the record's project/workspace —
 * wants the automation to land.
 *
 * The CLI cannot project a host itself, so it asks the same authority that will
 * perform the write to resolve the selector it was given and to name its
 * current SSH registrations. That captured incarnation rides along on the
 * request, and the authority re-checks it inside the write, so a target that
 * disappears in between fails the write instead of silently repointing the
 * record at a dead or re-registered host.
 */

import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../shared/automation-owner-conflict'
import type { AutomationDestination } from '../shared/automation-owner-precondition'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { SshTargetSummary } from '../shared/ssh-types'
import type { Repo } from '../shared/repo-types'
import type { RuntimeClient } from './runtime-client'

/** The project/workspace selectors the same request carries; both empty means the host cannot change. */
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

/**
 * `undefined` means the authority registers the target but assigns no
 * generation, which is a host with nothing to fence — not a host to fail
 * against. A target the authority does not register at all is positive
 * evidence that the destination is gone.
 */
async function sshTargetGeneration(
  client: RuntimeClient,
  targetId: string
): Promise<number | undefined> {
  const targets = (await client.call<{ targets: SshTargetSummary[] }>('ssh.listTargetSummaries'))
    .result.targets
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
