import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AcpJsonRpcConnection } from './acp-jsonrpc-connection'

export function acpProviderHandle(agent: string, acpSessionId: string): AgentSessionProviderHandle {
  if (agent === 'claude' || agent === 'openclaude') {
    return { provider: 'claude', sessionId: acpSessionId, leafUuid: null }
  }
  if (agent === 'codex') {
    return { provider: 'codex', threadId: acpSessionId }
  }
  if (agent === 'cursor') {
    return { provider: 'cursor', sessionId: acpSessionId }
  }
  return { provider: 'grok', sessionId: acpSessionId }
}

export function acpResumeSessionId(identity: AgentSessionJournalIdentity): string | null {
  const handle = identity.providerHandle
  if (handle.kind === 'claude') {
    return handle.sessionId
  }
  if (handle.kind === 'codex') {
    return handle.threadId
  }
  if (handle.kind === 'opaque' && handle.value !== 'pending') {
    return handle.value
  }
  return null
}

export async function authenticateAcpConnection(
  agent: string,
  connection: AcpJsonRpcConnection
): Promise<void> {
  const methods = connection.initialize.authMethods ?? []
  if (agent === 'cursor') {
    await connection.request('authenticate', { methodId: 'cursor_login' })
    return
  }
  const methodId = methods.find((method) => typeof method.id === 'string')?.id
  if (methodId) {
    await connection.request('authenticate', { methodId })
  }
}
