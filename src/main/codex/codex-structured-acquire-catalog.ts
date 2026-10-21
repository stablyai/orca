import type {
  CodexSessionCatalogAccess,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredLaunch
} from './codex-structured-session-state'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'

export function codexAcquireCatalogAccess(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'modelCatalog'>,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>
): CodexSessionCatalogAccess | undefined {
  return agentModelCatalogSessionAccess(deps.modelCatalog, CODEX_STRUCTURED_AGENT, launch.codexHome)
}
