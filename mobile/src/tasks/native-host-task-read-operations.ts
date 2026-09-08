import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import { MOBILE_TASKS_CAPABILITY } from './mobile-tasks-capability'
import type {
  HostTaskBootstrap,
  HostTaskLinearContext,
  HostTaskReadOperations,
  HostTaskRepository
} from './host-task-read-operations'
import type { RpcRequestReply, RpcRequestSender } from '../transport/rpc-client'

export function nativeHostTaskReadOperations(client: RpcRequestSender): HostTaskReadOperations {
  return {
    bootstrap: () => bootstrap(client),
    listRepositories: () => listRepositories(client),
    loadLinearContext: () => loadLinearContext(client),
    resolveGitHubRepoSlug: (repoId) => resolveGitHubRepoSlug(client, repoId)
  }
}

async function bootstrap(client: RpcRequestSender): Promise<HostTaskBootstrap> {
  const statusResponse = await client.sendRequest('status.get')
  requireSuccess(statusResponse)
  const status = statusResponse.result as { capabilities?: string[] }
  if (!status.capabilities?.includes(MOBILE_TASKS_CAPABILITY)) {
    return emptyBootstrap(false)
  }
  const [settingsResponse, uiResponse, preflightResponse, linearStatusResponse] = await Promise.all(
    [
      client.sendRequest('settings.get'),
      client.sendRequest('ui.get'),
      client.sendRequest('preflight.check'),
      client.sendRequest('linear.status')
    ]
  )
  const settingsEnvelope = successResult<{ settings?: HostTaskBootstrap['settings'] }>(
    settingsResponse
  )
  const uiEnvelope = successResult<{
    ui?: {
      taskResumeState?: HostTaskBootstrap['taskResumeState']
      trustedOrcaHooks?: HostTaskBootstrap['trustedOrcaHooks']
    }
  }>(uiResponse)
  const preflight = successResult<{ glab?: { installed?: boolean } }>(preflightResponse)
  return {
    supported: true,
    settings: settingsEnvelope?.settings ?? {},
    taskResumeState: uiEnvelope?.ui?.taskResumeState ?? {},
    trustedOrcaHooks: uiEnvelope?.ui?.trustedOrcaHooks ?? {},
    gitLabInstalled: preflight?.glab?.installed === true,
    linearStatus: normalizeLinearStatus(successResult(linearStatusResponse))
  }
}

async function listRepositories(client: RpcRequestSender): Promise<HostTaskRepository[]> {
  const response = await client.sendRequest('repo.list')
  requireSuccess(response)
  const result = response.result as { repos?: HostTaskRepository[] }
  return result.repos ?? []
}

async function loadLinearContext(client: RpcRequestSender): Promise<HostTaskLinearContext> {
  const statusResponse = await client.sendRequest('linear.status')
  requireSuccess(statusResponse)
  const status = normalizeLinearStatus(statusResponse.result)
  if (!status.connected) {
    return { status, teams: [] }
  }
  const workspaceId =
    status.selectedWorkspaceId ?? status.activeWorkspaceId ?? status.workspaces[0]?.id ?? null
  const teamsResponse = await client.sendRequest('linear.listTeams', {
    workspaceId: workspaceId ?? undefined
  })
  requireSuccess(teamsResponse)
  return {
    status: { ...status, selectedWorkspaceId: workspaceId },
    teams: teamsResponse.result as HostTaskLinearContext['teams']
  }
}

async function resolveGitHubRepoSlug(
  client: RpcRequestSender,
  repoId: string
): Promise<GitHubOwnerRepo | null> {
  const response = await client.sendRequest(
    'github.repoSlug',
    { repo: `id:${repoId}` },
    { timeoutMs: 30_000 }
  )
  requireSuccess(response)
  return response.result as GitHubOwnerRepo | null
}

function emptyBootstrap(supported: boolean): HostTaskBootstrap {
  return {
    supported,
    settings: {},
    taskResumeState: {},
    trustedOrcaHooks: {},
    gitLabInstalled: false,
    linearStatus: normalizeLinearStatus(null)
  }
}

function normalizeLinearStatus(value: unknown): HostTaskBootstrap['linearStatus'] {
  const status = (value ?? {}) as Partial<HostTaskBootstrap['linearStatus']>
  return {
    connected: status.connected === true,
    workspaces: Array.isArray(status.workspaces) ? status.workspaces : [],
    selectedWorkspaceId: status.selectedWorkspaceId ?? null,
    activeWorkspaceId: status.activeWorkspaceId ?? null
  }
}

function successResult<T>(response: RpcRequestReply): T | null {
  return response.ok ? (response.result as T) : null
}

function requireSuccess(
  response: RpcRequestReply
): asserts response is { ok: true; result: unknown } {
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task operation failed')
  }
}
