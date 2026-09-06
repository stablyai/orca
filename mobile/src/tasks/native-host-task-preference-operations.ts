import { persistSetupHookTrustApproval } from './setup-hook-trust'
import type { HostTaskPreferenceOperations } from './host-task-preference-operations'
import type { RpcClient } from '../transport/rpc-client'

export function nativeHostTaskPreferenceOperations(
  client: RpcClient
): HostTaskPreferenceOperations {
  return {
    async updateResume(taskResumeState) {
      requireSuccess(await client.sendRequest('ui.set', { taskResumeState }))
    },
    async updateSettings(settings) {
      requireSuccess(await client.sendRequest('settings.update', settings))
    },
    persistSetupTrust: (args) => persistSetupHookTrustApproval({ client, ...args })
  }
}

function requireSuccess(response: { ok: boolean; error?: { message?: string } }): void {
  if (!response.ok) {
    throw new Error(response.error?.message ?? 'Task preference update failed')
  }
}
