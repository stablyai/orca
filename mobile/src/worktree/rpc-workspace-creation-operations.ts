import type { RpcRequestSender } from '../transport/rpc-client'
import { persistSetupHookTrustApproval } from '../tasks/setup-hook-trust'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'
import { nativeHostWorkspaceCreationReadOperations } from './native-host-workspace-creation-read-operations'
import { nativeHostWorkspaceCreationSourceOperations } from './native-host-workspace-creation-source-operations'

/** Every workspace-creation call the screens make, written against a bare request sender so any
 * non-socket provider can supply one without a second copy. */
export function rpcWorkspaceCreationOperations(
  client: RpcRequestSender
): HostWorkspaceCreationOperations {
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
