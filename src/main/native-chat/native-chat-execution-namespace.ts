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

function antigravityConnectionNamespace(connectionId: string | null | undefined): string {
  if (isWslHookRelayConnectionId(connectionId)) {
    const distro = connectionId?.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length).trim()
    if (distro) {
      return distro
    }
  } else if (!connectionId) {
    return ''
  }
  throw new Error('Antigravity transcript execution namespace is unavailable')
}

export function antigravitySessionWslDistro(
  sessionId: string,
  expectedConnectionId?: string | null
): string | undefined {
  const namespaces = new Set<string>()
  if (expectedConnectionId !== undefined) {
    namespaces.add(antigravityConnectionNamespace(expectedConnectionId))
  }
  for (const row of readProviderSessions()) {
    if (row.agentType !== 'antigravity' || row.providerSession?.id !== sessionId) {
      continue
    }
    namespaces.add(antigravityConnectionNamespace(row.connectionId))
  }
  if (namespaces.size > 1) {
    throw new Error('Antigravity transcript execution namespace is ambiguous')
  }
  return namespaces.values().next().value || undefined
}
