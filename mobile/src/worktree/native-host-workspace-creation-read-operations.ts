import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { readNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import { readRetiredNameRegistryForRepo } from '../../../src/shared/worktree/retired-name-cache'
import type {
  HostWorkspaceCreationOperations,
  NewWorkspaceRepoHooks,
  NewWorkspaceRepository,
  NewWorkspaceRuntimeSettings
} from './host-workspace-creation-operations'

type ReadOperations = Pick<
  HostWorkspaceCreationOperations,
  | 'listRepositories'
  | 'readRetiredWorktreeNames'
  | 'readRuntimeSettings'
  | 'readTrustedHooks'
  | 'isGitLabCliInstalled'
  | 'isLinearConnected'
  | 'readSshState'
  | 'connectSsh'
  | 'detectAgents'
  | 'readRepoHooks'
  | 'readRuntimeCapabilities'
>

export function nativeHostWorkspaceCreationReadOperations(client: RpcClient): ReadOperations {
  return {
    async listRepositories() {
      const result = await successfulResult<{ repos: NewWorkspaceRepository[] }>(
        client.sendRequest('repo.list')
      )
      return result.repos
    },
    async readRetiredWorktreeNames(repoId) {
      const result = await successfulResult<unknown>(
        client.sendRequest('worktree.listRetiredNames', { repo: `id:${repoId}` })
      )
      return readRetiredNameRegistryForRepo(result, repoId)
    },
    async readRuntimeSettings() {
      const result = await successfulResult<{ settings: NewWorkspaceRuntimeSettings }>(
        client.sendRequest('settings.get')
      )
      return result.settings
    },
    async readTrustedHooks() {
      const result = await successfulResult<{
        ui?: { trustedOrcaHooks?: PersistedTrustedOrcaHooks }
      }>(client.sendRequest('ui.get'))
      return result.ui?.trustedOrcaHooks ?? {}
    },
    async isGitLabCliInstalled() {
      const response = await client.sendRequest('preflight.check')
      return response.ok
        ? ((response as RpcSuccess).result as { glab?: { installed?: boolean } }).glab
            ?.installed === true
        : false
    },
    async isLinearConnected() {
      const response = await client.sendRequest('linear.status')
      return response.ok
        ? ((response as RpcSuccess).result as { connected?: boolean }).connected === true
        : false
    },
    async readSshState(targetId) {
      const result = await successfulResult<{ state?: SshConnectionState | null }>(
        client.sendRequest('ssh.getState', { targetId })
      )
      return result.state ?? disconnectedSshState(targetId)
    },
    async connectSsh(targetId) {
      const result = await successfulResult<{ state?: SshConnectionState | null }>(
        client.sendRequest('ssh.connect', { targetId }, { timeoutMs: 120_000 })
      )
      return result.state ?? { ...disconnectedSshState(targetId), status: 'connected' }
    },
    async detectAgents(connectionId) {
      const response = connectionId
        ? await client.sendRequest('preflight.detectRemoteAgents', { connectionId })
        : await client.sendRequest('preflight.detectAgents')
      return response.ok ? ((response as RpcSuccess).result as string[]) : []
    },
    async readRepoHooks(repoId) {
      return successfulResult<NewWorkspaceRepoHooks>(
        client.sendRequest('repo.hooks', { repo: `id:${repoId}` })
      )
    },
    readRuntimeCapabilities() {
      return readNewWorktreeRuntimeCapabilities(client)
    }
  }
}

async function successfulResult<T>(
  responsePromise: ReturnType<RpcClient['sendRequest']>
): Promise<T> {
  const response = await responsePromise
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return (response as RpcSuccess).result as T
}

function disconnectedSshState(targetId: string): SshConnectionState {
  return {
    targetId,
    status: 'disconnected',
    error: null,
    reconnectAttempt: 0
  }
}
