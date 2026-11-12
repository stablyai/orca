// Capture the authority's SSH generation so it can reject removed or re-registered targets at write time.

import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../../shared/automations/ownership/automation-owner-conflict'
import type { AutomationDestination } from '../../shared/automations/ownership/automation-owner-precondition'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-worktree-contracts'
import type { SshTargetSummary } from '../../shared/ssh-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import { getManagedOrcadSshTargetId } from '../../shared/execution-host/managed-orcad-execution-host'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { RuntimeClient } from '../runtime/client'
import { fetchSshTargetSummaries } from '../host-selector-alternatives'

/** Empty selectors mean the execution host cannot change. */
export type AutomationDestinationTarget = { repo?: string; workspace?: string }

async function resolveTargetRepo(
  client: RuntimeClient,
  target: AutomationDestinationTarget
): Promise<{ repo: Repo; worktreeId?: string }> {
  if (target.repo) {
    return {
      repo: (await client.call<{ repo: Repo }>('repo.show', { repo: target.repo })).result.repo
    }
  }
  const worktree = (
    await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: target.workspace
    })
  ).result.worktree
  const { repo } = (
    await client.call<{ repo: Repo }>('repo.show', { repo: `id:${worktree.repoId}` })
  ).result
  return { repo, worktreeId: worktree.id }
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

type AutomationWriteTarget = {
  destination?: AutomationDestination
  repo?: Repo
  worktreeId?: string
}

async function resolveAutomationWriteTarget(
  client: RuntimeClient,
  target: AutomationDestinationTarget
): Promise<AutomationWriteTarget> {
  if (!target.repo && !target.workspace) {
    return {}
  }
  const { repo, worktreeId } = await resolveTargetRepo(client, target)
  const connectionId = getRepoRoutingConnectionId(repo)
  if (!connectionId) {
    return { destination: { selector: { kind: 'self' } }, repo, worktreeId }
  }
  const generation = await sshTargetGeneration(client, connectionId)
  return generation === undefined
    ? { repo, worktreeId }
    : {
        destination: {
          selector: { kind: 'ssh', targetId: connectionId, targetGeneration: generation }
        },
        repo,
        worktreeId
      }
}

/** The destination an edit names; the desktop refuses one on a managed SSH host. */
export async function resolveAutomationDestination(
  client: RuntimeClient,
  target: AutomationDestinationTarget
): Promise<AutomationDestination | undefined> {
  return (await resolveAutomationWriteTarget(client, target)).destination
}

/** A local CLI creates a managed SSH host's automation on its Orca server (#24863), by the ids both share. */
export async function routeAutomationCreate<
  TCreate extends { repo?: string; workspace?: string; runContext?: unknown }
>(
  client: RuntimeClient,
  target: AutomationDestinationTarget,
  create: TCreate
): Promise<{ writer: RuntimeClient; params: TCreate & { destination?: AutomationDestination } }> {
  const { destination, repo, worktreeId } = await resolveAutomationWriteTarget(client, target)
  const here = { writer: client, params: { ...create, ...(destination ? { destination } : {}) } }
  const connectionId = repo ? getRepoRoutingConnectionId(repo) : null
  const server =
    repo && connectionId && client.isRemote === false
      ? listEnvironments(client.userDataPath).find(
          (environment) => getManagedOrcadSshTargetId(environment) === connectionId
        )
      : undefined
  if (!repo || !server) {
    return here
  }
  const writer = new RuntimeClient(client.userDataPath, undefined, null, server.id)
  const { repos } = (await writer.call<{ repos: Pick<Repo, 'id'>[] }>('repo.list')).result
  // A project only on the desktop's copy goes to the desktop, which refuses it.
  if (!repos.some((entry) => entry.id === repo.id)) {
    return here
  }
  return {
    writer,
    params: {
      ...create,
      runContext: undefined,
      repo: create.repo === undefined ? undefined : `id:${repo.id}`,
      ...(worktreeId ? { workspace: `id:${worktreeId}` } : {})
    }
  }
}
