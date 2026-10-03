import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../shared/wsl-hook-relay-contract'

let readProviderSessions: () => readonly AgentStatusIpcPayload[] = () => []

export function configureNativeChatExecutionNamespace(
  read: () => readonly AgentStatusIpcPayload[]
): void {
  readProviderSessions = read
}

export function antigravitySessionWslDistro(sessionId: string): string | undefined {
  const namespaces = new Set<string>()
  for (const row of readProviderSessions()) {
    if (row.agentType !== 'antigravity' || row.providerSession?.id !== sessionId) {
      continue
    }
    if (isWslHookRelayConnectionId(row.connectionId)) {
      const distro = row.connectionId?.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length).trim()
      if (!distro) {
        throw new Error('Antigravity transcript execution namespace is unavailable')
      }
      namespaces.add(distro)
    } else if (!row.connectionId) {
      namespaces.add('')
    }
  }
  if (namespaces.size > 1) {
    throw new Error('Antigravity transcript execution namespace is ambiguous')
  }
  return namespaces.values().next().value || undefined
}
