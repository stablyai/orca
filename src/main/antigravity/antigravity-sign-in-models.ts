import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import type { AcpSessionStarted } from '../acp/acp-session-setup'
import { AcpStructuredOptions } from '../acp/acp-structured-options'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'

/** Cache session-only models so the first chat has a model picker. */
export function saveSignInModels(
  spec: AcpLaunchSpec,
  accountHome: AgentSessionAccountHome,
  started: AcpSessionStarted
): void {
  const options = new AcpStructuredOptions(spec.dialect)
  options.adoptSession(started.response, 'new')
  const { models } = options.read()
  if (models.length > 0) {
    agentModelCatalogStore.recordSuccess(
      agentModelCatalogFingerprint({ agent: spec.agent, accountHome, wslDistro: null }),
      spec.agent,
      { models, origin: 'live-session' },
      'live'
    )
  }
}
