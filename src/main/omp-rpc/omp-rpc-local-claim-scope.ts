import type { ProviderExecutionNamespace } from '../runtime/agent-session-claim-identity'

export const OMP_RPC_LOCAL_NAMESPACE: ProviderExecutionNamespace = {
  machine: 'local',
  principal: 'local',
  container: 'local',
  providerRoot: 'local'
}

export const OMP_RPC_LOCAL_WORKTREE_SCOPE = 'omp-rpc-chat-session'
