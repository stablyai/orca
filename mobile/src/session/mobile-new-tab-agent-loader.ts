import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
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
  executionHostId?: string | null
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
  return requestDetectedAgentsForRepo(client, repo)
}

async function requestDetectedAgentsForRepo(
  client: RpcClient,
  repo: RuntimeRepoSummary
): Promise<RpcSuccess | RpcFailure> {
  const executionHost = parseExecutionHostId(repo.executionHostId)
  if (executionHost?.kind === 'runtime') {
    return requestRuntimeDetectedAgents(client, executionHost.environmentId)
  }
  if (executionHost?.kind === 'ssh') {
    return client.sendRequest('preflight.detectRemoteAgents', {
      connectionId: executionHost.targetId
    })
  }
  const connectionId = repo.connectionId?.trim() || null
  return connectionId
    ? client.sendRequest('preflight.detectRemoteAgents', { connectionId })
    : client.sendRequest('preflight.detectAgents')
}

async function requestRuntimeDetectedAgents(
  client: RpcClient,
  environmentId: string
): Promise<RpcSuccess | RpcFailure> {
  const response = await client.sendRequest('preflight.detectRuntimeAgents', {
    environmentId
  })
  // Why: hosts that predate the runtime-delegation RPC fall back to the paired
  // host's local detection (previous behavior) instead of blanking the menu.
  if (!response.ok && isMethodUnavailable(response as RpcFailure)) {
    return client.sendRequest('preflight.detectAgents')
  }
  return response
}

function isMethodUnavailable(response: RpcFailure): boolean {
  const code = response.error.code
  const message = response.error.message
  return (
    code === 'method_not_found' ||
    message.includes('not available to mobile clients') ||
    message.includes('Unknown method')
  )
}
