import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import type { AgentModelCatalogReadOperation } from './agent-model-catalog-operation'
import { agentModelCatalogReadRecords } from './agent-model-catalog-read-scope'
import { usesModelSpecificAcpEfforts } from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import type {
  AgentModelCatalogLaunch,
  AgentModelCatalogRefresh,
  createAgentModelCatalogRefreshes
} from './agent-model-catalog-refresh'

/** Picks the refresh a read's request needs; readers of one request share it, whatever chat. */
export function createAgentModelCatalogLookup(
  deps: AgentModelCatalogServiceDeps,
  refreshes: ReturnType<typeof createAgentModelCatalogRefreshes>,
  requestKey: (params: AgentModelCatalogReadParams) => string,
  capture: (params: AgentModelCatalogReadParams) => string
) {
  const launchFor = (
    params: AgentModelCatalogReadParams
  ): { key: string; launch: AgentModelCatalogLaunch } | undefined => {
    // This reader's own chat decides whether it may list; only readers that agree share one.
    const records = agentModelCatalogReadRecords(deps, params)
    if (!records) {
      return undefined
    }
    const bindingKey = requestKey(params)
    const identity = capture(params)
    const passive = !!params.savedOnly || records.savedOnly
    return {
      key: JSON.stringify([bindingKey, identity, passive]),
      launch: {
        agent: params.agent,
        records,
        workspacePath: params.workspacePath,
        inSessionWorkspace: params.inSessionWorkspace,
        legacy: params.legacy,
        passive,
        requireConfiguredDefault: params.requireConfiguredDefault,
        bindingKey,
        identity
      }
    }
  }
  return {
    /** Starts or joins the refresh this read needs, while the read itself is still current. */
    request(
      params: AgentModelCatalogReadParams,
      operation: AgentModelCatalogReadOperation
    ): AgentModelCatalogRefresh | undefined {
      const found = operation.current() ? launchFor(params) : undefined
      if (!found) {
        return undefined
      }
      const refresh = refreshes.join(found.key, found.launch)
      refresh.want(
        usesModelSpecificAcpEfforts(params.agent)
          ? (params.selectedModel ??
              (params.sessionId
                ? deps.getConversation(params.sessionId)?.options?.model
                : undefined))
          : undefined
      )
      return refresh
    },
    /** Whether a refresh this read would join is still running. */
    pending(params: AgentModelCatalogReadParams): boolean {
      const found = launchFor(params)
      return !!found && refreshes.pending(found.key)
    }
  }
}
