// `agentAwake.*` — the host's keep-awake verdict over RPC. The desktop's
// `AgentAwakeService` resolves {mode, active} in-process against its own
// `powerSaveBlocker`; a client that owns the OS blocker in another process
// (the Tauri shell) needs the same verdict from the runtime that owns the
// agent status store, which is why orcad computes it and these methods serve
// it.

import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { bindStructuredAgentSessionStream } from './structured-sessions/subscriptions/structured-agent-session-status-stream'
import type { OrcadAgentAwakeService } from '../../../orcad/orcad-agent-awake'

// Why a module setter: RpcContext only carries OrcaRuntimeService, and the
// awake service is composed in orcad-entry beside the hook server — the same
// boundary pattern as `setPluginServiceForRpc`.
let agentAwakeServiceForRpc: OrcadAgentAwakeService | null = null

export function setAgentAwakeServiceForRpc(service: OrcadAgentAwakeService | null): void {
  agentAwakeServiceForRpc = service
}

function requireAgentAwakeService(): OrcadAgentAwakeService {
  if (!agentAwakeServiceForRpc) {
    throw new Error('agent_awake_unavailable')
  }
  return agentAwakeServiceForRpc
}

export const AGENT_AWAKE_METHODS = [
  defineMethod({
    name: 'agentAwake.getStatus',
    permission: 'workspace',
    params: null,
    handler: () => requireAgentAwakeService().getStatus()
  }),
  defineStreamingMethod({
    name: 'agentAwake.subscribeStatus',
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx: RpcContext, emit) => {
      const service = requireAgentAwakeService()
      const subscriptionId = `agent-awake:${ctx.clientId ?? 'client'}`
      let unsubscribe = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => unsubscribe())
      if (stream.isClosed()) {
        return
      }
      unsubscribe = service.subscribe((status) => emit(status))
      // Every subscriber gets the current verdict on attach — a late client
      // cannot wait for the next agent status change to learn the mode.
      emit(service.getStatus())
    }
  })
]
