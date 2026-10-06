import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import type { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { CLAUDE_STRUCTURED_AGENT } from './claude-structured-agent-definition'

/** A Claude session's catalog, keyed by the config directory it launched under. */
export function claudeAcquireCatalogAccess(
  store: AgentModelCatalogStore | undefined,
  claudeConfigDir: string | null
) {
  return agentModelCatalogSessionAccess(store, CLAUDE_STRUCTURED_AGENT, claudeConfigDir)
}
