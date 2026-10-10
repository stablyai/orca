import { createCodexModelCatalogProbe } from '../../codex/codex-model-catalog-probe'
import {
  createAgentModelCatalogService,
  type AgentModelCatalogService,
  type AgentModelCatalogServiceDeps
} from '../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { attachAgentModelCatalogPersistenceOnce } from '../structured-agent-model-catalog-wiring'
import { createStructuredAgentEnvironmentResolvers } from '../structured-agent-shell-environment'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveTuiAgentLaunchEnv } from '../../../shared/tui-agent-launch-defaults'
import { nativeChatShellEnvironmentPolicy } from '../../../shared/native-chat-shell-environment'

export type CodexWorkerModelCatalog = Pick<AgentModelCatalogService, 'read'>

/**
 * The same host catalog native chat's model picker reads (one `model/list`
 * probe per Codex account, shared cache), built without installing the
 * structured-session host: worker-start only needs the listing.
 */
export function createCodexWorkerModelCatalog(deps: {
  getSettings: () => GlobalSettings
  resolveAccountHome: AgentModelCatalogServiceDeps['resolveAccountHome']
}): CodexWorkerModelCatalog {
  let service: Promise<AgentModelCatalogService> | null = null
  return {
    read: async (params) => {
      service ??= attachAgentModelCatalogPersistenceOnce(getProfileUserDataPath()).then(() =>
        createAgentModelCatalogService({
          store: agentModelCatalogStore,
          getRecord: () => undefined,
          resolveAccountHome: deps.resolveAccountHome,
          probes: {
            codex: createCodexModelCatalogProbe({
              // Same env sources as the structured host's Codex launches.
              resolveEnvironment: createStructuredAgentEnvironmentResolvers({
                resolveLaunchEnvOverlay: () =>
                  resolveTuiAgentLaunchEnv('codex', deps.getSettings().agentDefaultEnv),
                resolveShellEnvironmentPolicy: () =>
                  nativeChatShellEnvironmentPolicy(deps.getSettings())
              }).resolveCodexEnvironment
            })
          }
        })
      )
      return (await service).read(params)
    }
  }
}

/**
 * The efforts this host's Codex lists for `model`, or null when it cannot say:
 * listing failed, or the model is absent (hidden models are not listed), so the
 * caller falls back to Orca's static catalog.
 */
export async function readCodexWorkerModelEfforts(
  catalog: CodexWorkerModelCatalog,
  model: string
): Promise<string[] | null> {
  try {
    const result = await catalog.read({ agent: 'codex', waitForListing: true })
    if (result.origin === 'unknown') {
      return null
    }
    const efforts = result.models.find((entry) => entry.id === model)?.efforts ?? []
    return efforts.length > 0 ? efforts.map((choice) => choice.value) : null
  } catch {
    return null
  }
}
