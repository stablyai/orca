// Capture the authority's SSH generation so it can reject removed or re-registered targets at write time.

import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../shared/automation-owner-conflict'
import type { AutomationDestination } from '../shared/automation-owner-precondition'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { SshTargetSummary } from '../shared/ssh-types'
import type { Repo } from '../shared/repo-types'
import { getManagedOrcadSshTargetId } from '../shared/managed-orcad-execution-host'
import { listEnvironments } from '../shared/remote-runtime/host-store/runtime-environment-store'
import { getDefaultUserDataPath, RuntimeClient, RuntimeClientError } from './runtime-client'
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

// An unregistered target is gone.
async function registeredSshTarget(
  client: RuntimeClient,
  targetId: string
): Promise<SshTargetSummary> {
  const { targets } = await fetchSshTargetSummaries<SshTargetSummary>(client)
  const match = targets.find((candidate) => candidate.id === targetId)
  if (!match) {
    throw new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination)
  }
  return match
}

/** Where a write lands: here, or the managed Orca server that holds an SSH host's automations (#24863). */
type AutomationWriteRoute =
  | { kind: 'here'; destination?: AutomationDestination }
  | { kind: 'server'; environmentId: string; host: string; repoId: string }

async function resolveAutomationWriteRoute(
  client: RuntimeClient,
  target: AutomationDestinationTarget
): Promise<AutomationWriteRoute> {
  if (!target.repo && !target.workspace) {
    return { kind: 'here' }
  }
  const repo = await resolveTargetRepo(client, target)
  const connectionId = repo.connectionId?.trim()
  if (!connectionId) {
    return { kind: 'here', destination: { selector: { kind: 'self' } } }
  }
  const sshTarget = await registeredSshTarget(client, connectionId)
  const server = listEnvironments(getDefaultUserDataPath()).find(
    (environment) => getManagedOrcadSshTargetId(environment) === connectionId
  )
  if (server) {
    return { kind: 'server', environmentId: server.id, host: sshTarget.label, repoId: repo.id }
  }
  // A registered target without a generation needs no fence.
  return sshTarget.generation === undefined
    ? { kind: 'here' }
    : {
        kind: 'here',
        destination: {
          selector: { kind: 'ssh', targetId: connectionId, targetGeneration: sshTarget.generation }
        }
      }
}

/** The client a create goes to, with its params; a managed SSH host's server takes it by project id. */
export async function routeAutomationCreate<
  TCreate extends { repo?: string; runContext?: unknown }
>(
  client: RuntimeClient,
  target: AutomationDestinationTarget,
  create: TCreate
): Promise<{ writer: RuntimeClient; params: TCreate & { destination?: AutomationDestination } }> {
  const route = await resolveAutomationWriteRoute(client, target)
  if (route.kind === 'here') {
    return {
      writer: client,
      params: { ...create, ...(route.destination ? { destination: route.destination } : {}) }
    }
  }
  const server = new RuntimeClient(getDefaultUserDataPath(), undefined, null, route.environmentId)
  const { repos } = (await server.call<{ repos: Pick<Repo, 'id'>[] }>('repo.list')).result
  if (!repos.some((repo) => repo.id === route.repoId)) {
    throw new RuntimeClientError('invalid_argument', `Move this project to ${route.host} first.`)
  }
  // The server sets the project up from its own records, not the desktop's SSH run context.
  return {
    writer: server,
    params: {
      ...create,
      runContext: undefined,
      repo: create.repo === undefined ? undefined : `id:${route.repoId}`
    }
  }
}

/** An edit cannot move a row to another authority, so a managed SSH host refuses it. */
export async function resolveAutomationUpdateDestination(
  client: RuntimeClient,
  target: AutomationDestinationTarget
): Promise<AutomationDestination | undefined> {
  const route = await resolveAutomationWriteRoute(client, target)
  if (route.kind === 'server') {
    throw new RuntimeClientError(
      'invalid_argument',
      `${route.host} now runs automations on its Orca server`
    )
  }
  return route.destination
}
