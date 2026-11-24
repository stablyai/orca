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
  const idsByConfigDir = new Map<string, Set<string>>()
  const wslSessionIds = new Set<string>()
  for (const provider of historyRowOwners('cursor')) {
    const history = structuredAgentRuntimeMetadata(provider)?.sessionHistory
    for (const chat of history ? store.conversationsKeyedBy(providerKeys, provider) : []) {
      // The chat pins CURSOR_CONFIG_DIR to its account folder, where Cursor writes acp-sessions.
      const ids = chat.location.wslDistro
        ? wslSessionIds
        : isLegacyAgentSessionAccountHome(chat.accountHome)
          ? idsInFolder(idsByConfigDir, chat.accountHome.path)
          : null
      for (const link of ids ? chat.providerHandleChain : []) {
        ids!.add(history!.rowSessionId(link))
      }
    }
  }
  return idsByConfigDir.size > 0 || wslSessionIds.size > 0
    ? {
        folders: [...idsByConfigDir].map(([configDir, ids]) => ({
          configDir,
          sessionIds: [...ids]
        })),
        wslSessionIds: [...wslSessionIds]
      }
    : undefined
}

function idsInFolder(byFolder: Map<string, Set<string>>, configDir: string): Set<string> {
  let ids = byFolder.get(configDir)
  if (!ids) {
    ids = new Set()
    byFolder.set(configDir, ids)
  }
  return ids
}
