import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { selectExactWorkerProviderSession } from '../../../../orchestration/worker-provider-session'

export function attestFederationLeadProvider(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockImplementation(() => {
    const paneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    return selectExactWorkerProviderSession({
      paneKey,
      processIncarnation: 'windows_runtime:pty:1',
      connectionId: null,
      launchToken: undefined,
      observedAfter: 0,
      statuses: [
        {
          paneKey,
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          state: 'working',
          prompt: '',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'lead-session' },
          actorAttestation: {
            authorityId: 'agent-hook-main:test',
            incarnation: 1,
            revision: 1,
            observedAt: Date.now(),
            provider: 'codex',
            role: 'lead',
            eventName: 'PreToolUse',
            providerSessionId: 'lead-session',
            toolUseId: 'tool-lead'
          }
        }
      ]
    })
  })
}

export function lifecycleResult(response: RuntimeRpcResponse<unknown>): string {
  if (!response.ok) {
    return `error:${response.error.code}`
  }
  const result = response.result as { lifecycle?: { action?: string } }
  return result.lifecycle?.action ?? 'missing'
}
