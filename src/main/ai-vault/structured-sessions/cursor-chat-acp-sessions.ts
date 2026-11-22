import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentSessionConversationKeys } from '../../runtime/agent-session/records/agent-session-conversation-key-index'
import { structuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import type { AiVaultScanOptions } from '../session-scanner-types'
import { historyRowOwners } from './history-row-ownership-lookup'

// Module-level so the store keeps one provider index instead of walking every saved chat.
const providerKeys: AgentSessionConversationKeys = ({ provider }) => [provider]

/** The Cursor sessions native Chat owns, for the scanner to list them and nothing else. */
export function cursorChatAcpSessions(): AiVaultScanOptions['cursorAcpSessions'] {
  const store = getStructuredAgentSessionHost()?.deps.store
  if (!store) {
    return undefined
  }
  const sessionIds = new Set<string>()
  const configDirs = new Set<string>()
  let inWsl = false
  for (const provider of historyRowOwners('cursor')) {
    const history = structuredAgentRuntimeMetadata(provider)?.sessionHistory
    for (const chat of history ? store.conversationsKeyedBy(providerKeys, provider) : []) {
      for (const link of chat.providerHandleChain) {
        sessionIds.add(history!.rowSessionId(link))
      }
      if (chat.location.wslDistro) {
        inWsl = true
      } else if (isLegacyAgentSessionAccountHome(chat.accountHome)) {
        // The chat pins CURSOR_CONFIG_DIR to this folder, where Cursor writes acp-sessions.
        configDirs.add(chat.accountHome.path)
      }
    }
  }
  return sessionIds.size > 0
    ? { sessionIds: [...sessionIds], configDirs: [...configDirs], inWsl }
    : undefined
}
