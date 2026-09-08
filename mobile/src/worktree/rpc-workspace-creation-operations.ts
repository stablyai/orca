import type { RpcRequestSender } from '../transport/rpc-client'
import { persistSetupHookTrustApproval } from '../tasks/setup-hook-trust'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'
import { nativeHostWorkspaceCreationReadOperations } from './native-host-workspace-creation-read-operations'
import { nativeHostWorkspaceCreationSourceOperations } from './native-host-workspace-creation-source-operations'

export type RpcWorkspaceCreationOperations = Omit<
  HostWorkspaceCreationOperations,
  'createBlankWorkspace' | 'createWorkspaceFromSource'
>

/** Every workspace-creation call that is a plain desktop request. The native app passes its socket
 * and the hosted page passes a bridge-backed sender, so neither side owns a second copy. Creation
 * itself is excluded: it needs connection state for its retry, which a sender cannot report. */
export function rpcWorkspaceCreationOperations(
  client: RpcRequestSender
): RpcWorkspaceCreationOperations {
  return {
    ...nativeHostWorkspaceCreationReadOperations(client),
    ...nativeHostWorkspaceCreationSourceOperations(client),
    async listSparsePresets(repoId) {
      const response = await client.sendRequest('repo.sparsePresets', { repo: `id:${repoId}` })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return (
        (
          response.result as {
            presets?: Awaited<ReturnType<HostWorkspaceCreationOperations['listSparsePresets']>>
          }
        ).presets ?? []
      )
    },
    async saveSparsePreset(repoId, payload) {
      const response = await client.sendRequest('repo.saveSparsePreset', {
        repo: `id:${repoId}`,
        ...payload
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const preset = (
        response.result as {
          preset?: Awaited<ReturnType<HostWorkspaceCreationOperations['saveSparsePreset']>>
        }
      ).preset
      if (!preset) {
        throw new Error('Failed to save sparse preset.')
      }
      return preset
    },
    persistSetupTrust: (args) => persistSetupHookTrustApproval({ client, ...args })
  }
}
