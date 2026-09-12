import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import {
  getFolderWorkspaceIdFromMobileWorktreeId,
  getRepoIdFromMobileWorktreeId
} from './mobile-session-route-helpers'
import {
  buildMobileNewTabAgentOptions,
  type MobileNewTabAgentOption,
  type MobileNewTabAgentSettings
} from './mobile-new-tab-agent-options'

type RuntimeRepoSummary = {
  id: string
  connectionId?: string | null
}

type RuntimeFolderWorkspaceSummary = {
  id: string
  projectGroupId?: string | null
  connectionId?: string | null
}

type RuntimeProjectGroupSummary = {
  id: string
  connectionId?: string | null
}

export async function loadMobileNewTabAgentOptions(args: {
  client: RpcClient
  worktreeId: string
}): Promise<MobileNewTabAgentOption[]> {
  const { client, worktreeId } = args
  const detectedAgentsRequest = requestDetectedAgents(client, worktreeId)
  const [settingsResponse, detectedResponse] = await Promise.all([
    client.sendRequest('settings.get'),
    detectedAgentsRequest
  ])
  if (!settingsResponse.ok) {
    throw new Error((settingsResponse as RpcFailure).error.message)
  }
  if (!detectedResponse.ok) {
    throw new Error((detectedResponse as RpcFailure).error.message)
  }
  const settings = (
    (settingsResponse as RpcSuccess).result as {
      settings?: MobileNewTabAgentSettings
    }
  ).settings
  return buildMobileNewTabAgentOptions(
    settings,
    (detectedResponse as RpcSuccess).result as unknown[]
  )
}

function requestDetectedAgents(client: RpcClient, worktreeId: string) {
  // Why: the floating workspace runs on the paired host, so it has no repo connection to resolve.
  if (isFloatingWorkspaceWorktreeId(worktreeId)) {
    return client.sendRequest('preflight.detectAgents')
  }
  const folderWorkspaceId = getFolderWorkspaceIdFromMobileWorktreeId(worktreeId)
  if (folderWorkspaceId) {
    return loadFolderWorkspaceDetectedAgents(client, folderWorkspaceId)
  }
  return loadWorkspaceDetectedAgents(client, worktreeId)
}

async function loadWorkspaceDetectedAgents(client: RpcClient, worktreeId: string) {
  const repoResponse = await client.sendRequest('repo.list')
  if (!repoResponse.ok) {
    throw new Error((repoResponse as RpcFailure).error.message)
  }
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  const repos =
    ((repoResponse as RpcSuccess).result as { repos?: RuntimeRepoSummary[] }).repos ?? []
  const repo = repos.find((candidate) => candidate.id === repoId)
  if (!repo) {
    throw new Error('worktree_repo_not_found')
  }
  return detectAgentsForConnection(client, repo.connectionId)
}

/** A folder workspace names no repo, so its execution host comes from the workspace's own
 *  connection, falling back to its project group's. Anything unresolvable detects locally:
 *  the workspace is never in the worktree catalog, so treating a miss as an error would
 *  leave presets permanently unavailable — including against a host too old to list them. */
async function loadFolderWorkspaceDetectedAgents(client: RpcClient, folderWorkspaceId: string) {
  const [workspacesResponse, groupsResponse] = await Promise.all([
    client.sendRequest('folderWorkspace.list'),
    client.sendRequest('projectGroup.list')
  ])
  if (!workspacesResponse.ok || !groupsResponse.ok) {
    return client.sendRequest('preflight.detectAgents')
  }
  const workspaces =
    (
      (workspacesResponse as RpcSuccess).result as {
        folderWorkspaces?: RuntimeFolderWorkspaceSummary[]
      }
    ).folderWorkspaces ?? []
  const workspace = workspaces.find((candidate) => candidate.id === folderWorkspaceId)
  const groups =
    ((groupsResponse as RpcSuccess).result as { groups?: RuntimeProjectGroupSummary[] }).groups ?? []
  const group = workspace?.projectGroupId
    ? groups.find((candidate) => candidate.id === workspace.projectGroupId)
    : undefined
  return detectAgentsForConnection(client, workspace?.connectionId ?? group?.connectionId)
}

function detectAgentsForConnection(client: RpcClient, connectionId: string | null | undefined) {
  const normalized = connectionId?.trim() || null
  return normalized
    ? client.sendRequest('preflight.detectRemoteAgents', { connectionId: normalized })
    : client.sendRequest('preflight.detectAgents')
}
