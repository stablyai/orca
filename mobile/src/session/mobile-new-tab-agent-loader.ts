import { newTabSettingsRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import {
  buildMobileNewTabAgentOptions,
  type MobileNewTabAgentOption,
  type MobileNewTabAgentSettings
} from './mobile-new-tab-agent-options'

type RuntimeRepoSummary = {
  id: string
  connectionId?: string | null
}

export async function loadMobileNewTabAgentOptions(args: {
  client: RpcClient
  worktreeId: string
}): Promise<MobileNewTabAgentOption[]> {
  const { client, worktreeId } = args

  // Why: the floating workspace runs on the paired host, so it has no repo connection to resolve.
  const detectedAgentsRequest = isFloatingWorkspaceWorktreeId(worktreeId)
    ? client.sendRequest('preflight.detectAgents')
    : loadWorkspaceDetectedAgents(client, worktreeId)

  const [settingsResponse, detectedResponse] = await Promise.all([
    newTabSettingsRead.request(client),
    detectedAgentsRequest
  ])

  const readSettings = newTabSettingsRead.interpret(settingsResponse)

  if (!detectedResponse.ok) {
    throw new Error((detectedResponse as RpcFailure).error.message)
  }

  return buildMobileNewTabAgentOptions(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
    readSettings() as MobileNewTabAgentSettings | undefined,
    (detectedResponse as RpcSuccess).result as unknown[]
  )
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

  const connectionId = repo.connectionId?.trim() || null

  return connectionId
    ? client.sendRequest('preflight.detectRemoteAgents', { connectionId })
    : client.sendRequest('preflight.detectAgents')
}
