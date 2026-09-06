import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import { MOBILE_TASKS_CAPABILITY } from './mobile-tasks-capability'
import type {
  HostTaskBootstrap,
  HostTaskLinearContext,
  HostTaskReadOperations,
  HostTaskRepository
} from './host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

export function nativeHostTaskReadOperations(client: RpcClient): HostTaskReadOperations {
  return {
    bootstrap: () => bootstrap(client),
    listRepositories: () => listRepositories(client),
    loadLinearContext: () => loadLinearContext(client),
    resolveGitHubRepoSlug: (repoId) => resolveGitHubRepoSlug(client, repoId)
  }
}

async function bootstrap(client: RpcClient): Promise<HostTaskBootstrap> {
  const statusResponse = await client.sendRequest('status.get')
  requireSuccess(statusResponse)
  const status = (statusResponse as RpcSuccess).result as { capabilities?: string[] }
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

async function listRepositories(client: RpcClient): Promise<HostTaskRepository[]> {
  const response = await client.sendRequest('repo.list')
  requireSuccess(response)
  const result = (response as RpcSuccess).result as { repos?: HostTaskRepository[] }
  return result.repos ?? []
}

async function loadLinearContext(client: RpcClient): Promise<HostTaskLinearContext> {
  const statusResponse = await client.sendRequest('linear.status')
  requireSuccess(statusResponse)
  const status = normalizeLinearStatus((statusResponse as RpcSuccess).result)
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
    teams: (teamsResponse as RpcSuccess).result as HostTaskLinearContext['teams']
  }
}

async function resolveGitHubRepoSlug(
  client: RpcClient,
  repoId: string
): Promise<GitHubOwnerRepo | null> {
  const response = await client.sendRequest(
    'github.repoSlug',
    { repo: `id:${repoId}` },
    { timeoutMs: 30_000 }
  )
  requireSuccess(response)
  return (response as RpcSuccess).result as GitHubOwnerRepo | null
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

function successResult<T>(response: { ok: boolean; result?: unknown }): T | null {
  return response.ok ? (response.result as T) : null
}

function requireSuccess(response: { ok: boolean; error?: { message?: string } }): void {
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task operation failed')
  }
}
