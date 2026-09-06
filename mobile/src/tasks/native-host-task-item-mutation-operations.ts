import type { MobileWebTaskItemMetadataUpdates } from '../../../src/shared/mobile-web/task-item-mutation-contract'
import type {
  HostTaskItemMutationOperations,
  HostTaskItemMutationTarget
} from './host-task-item-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'

export function nativeHostTaskItemMutationOperations(
  client: RpcClient
): HostTaskItemMutationOperations {
  return {
    async setClosed(target, closed) {
      const response =
        target.provider === 'github'
          ? await setGitHubClosed(client, target, closed)
          : await setGitLabClosed(client, target, closed)
      assertMutation(response, 'Failed to update task status')
    },
    async updateMetadata(target, updates) {
      const response =
        target.provider === 'github'
          ? await updateGitHubMetadata(client, target, updates)
          : await updateGitLabMetadata(client, target, updates)
      assertMutation(response, 'Failed to update task')
    }
  }
}

function setGitHubClosed(
  client: RpcClient,
  target: Extract<HostTaskItemMutationTarget, { provider: 'github' }>,
  closed: boolean
) {
  const state = closed ? 'closed' : 'open'
  return target.type === 'issue'
    ? client.sendRequest('github.updateIssue', {
        repo: `id:${target.repoId}`,
        number: target.number,
        updates: { state }
      })
    : client.sendRequest('github.updatePRState', {
        repo: `id:${target.repoId}`,
        prNumber: target.number,
        updates: { state }
      })
}

function setGitLabClosed(
  client: RpcClient,
  target: Extract<HostTaskItemMutationTarget, { provider: 'gitlab' }>,
  closed: boolean
) {
  const state = closed ? 'closed' : 'opened'
  return target.type === 'issue'
    ? client.sendRequest('gitlab.updateIssue', {
        repo: `id:${target.repoId}`,
        number: target.number,
        updates: { state },
        projectRef: target.projectRef
      })
    : client.sendRequest('gitlab.updateMRState', {
        repo: `id:${target.repoId}`,
        iid: target.number,
        state,
        projectRef: target.projectRef
      })
}

function updateGitHubMetadata(
  client: RpcClient,
  target: Extract<HostTaskItemMutationTarget, { provider: 'github' }>,
  updates: MobileWebTaskItemMetadataUpdates
) {
  return target.type === 'issue'
    ? client.sendRequest(
        'github.updateIssue',
        { repo: `id:${target.repoId}`, number: target.number, updates },
        { timeoutMs: 30_000 }
      )
    : client.sendRequest(
        'github.updatePR',
        {
          repo: `id:${target.repoId}`,
          prNumber: target.number,
          updates: { title: updates.title, body: updates.body }
        },
        { timeoutMs: 30_000 }
      )
}

function updateGitLabMetadata(
  client: RpcClient,
  target: Extract<HostTaskItemMutationTarget, { provider: 'gitlab' }>,
  updates: MobileWebTaskItemMetadataUpdates
) {
  return target.type === 'issue'
    ? client.sendRequest(
        'gitlab.updateIssue',
        {
          repo: `id:${target.repoId}`,
          number: target.number,
          updates,
          projectRef: target.projectRef
        },
        { timeoutMs: 30_000 }
      )
    : client.sendRequest(
        'gitlab.updateMR',
        {
          repo: `id:${target.repoId}`,
          iid: target.number,
          projectRef: target.projectRef,
          updates: {
            title: updates.title,
            body: updates.body,
            addLabels: updates.addLabels,
            removeLabels: updates.removeLabels
          }
        },
        { timeoutMs: 30_000 }
      )
}

function assertMutation(
  response: Awaited<ReturnType<RpcClient['sendRequest']>>,
  fallback: string
): void {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = response.result as { ok?: boolean; error?: string }
  if (result.ok === false) {
    throw new Error(result.error ?? fallback)
  }
}
