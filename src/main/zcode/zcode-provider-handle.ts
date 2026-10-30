import type {
  AgentSessionProviderHandle,
  AgentSessionProviderHandleNamespace
} from '../../shared/agent-session-provider-handle'

export const ZCODE_STRUCTURED_HANDLE_NAMESPACE = {
  transport: 'zcode-app-server',
  agent: 'zcode'
} as const satisfies AgentSessionProviderHandleNamespace

export function zcodeProviderHandle(providerSessionId: string): AgentSessionProviderHandle {
  return { ...ZCODE_STRUCTURED_HANDLE_NAMESPACE, nativeId: providerSessionId }
}
