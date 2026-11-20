import type { AgentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogSessionAccess } from '../../../native-chat/agent-model-catalog/agent-model-catalog-lister'

export type CodexSessionCatalogAccess = AgentModelCatalogSessionAccess & {
  read?: (verifiedOnly?: boolean) => ReturnType<AgentModelCatalogStore['get']>
  demand?: (legacy?: boolean) => Promise<unknown>
}
