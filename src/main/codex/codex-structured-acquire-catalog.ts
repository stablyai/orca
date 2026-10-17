import type {
  CodexSessionCatalogAccess,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredLaunch
} from './codex-structured-session-state'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'

/** `startedAt` is the app-server's start: what its listings rank by against other producers. */
export function codexAcquireCatalogAccess(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'modelCatalog'>,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>,
  startedAt: number | null
): CodexSessionCatalogAccess | undefined {
  const access = agentModelCatalogSessionAccess(
    deps.modelCatalog,
    CODEX_STRUCTURED_AGENT,
    launch.codexHome
  )
  return access && { ...access, startedAt }
}
