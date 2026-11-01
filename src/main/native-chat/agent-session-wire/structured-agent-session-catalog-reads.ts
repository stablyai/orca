import type { AgentModelCatalogReadParams } from '../agent-model-catalog/agent-model-catalog-service-contract'
import { withinAgentModelCatalogRead } from '../agent-model-catalog/agent-model-catalog-operation'
import { resolveAgentModelCatalogReadRecords } from '../agent-model-catalog/agent-model-catalog-running-account'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'

/** The caller already owns the conversation; every projection of this invocation shares this scope. */
export function structuredAgentSessionCatalogScopeOwned(
  deps: StructuredAgentSessionHostDeps,
  params: AgentModelCatalogReadParams,
  session: StructuredAgentSessionHostSession | undefined
) {
  return resolveAgentModelCatalogReadRecords(
    {
      getConversation: (id) => deps.store.getConversation(id) ?? undefined,
      getRecord: (id) => deps.store.getRecord(id) ?? undefined,
      drivesRecord: () => true,
      liveAccountHome: () => session?.child?.accountHome,
      launchAccountHome: async (record) =>
        (await structuredAgentSessionReceivingAccount(deps, record, session)).home
    },
    params
  )
}

/** Named external reads acquire once, after capture and before nonacquiring preparation. */
export function createStructuredAgentSessionCatalogReads(
  context: () => {
    deps: StructuredAgentSessionHostDeps
    serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
    scopeOwned: (
      params: AgentModelCatalogReadParams
    ) => ReturnType<typeof structuredAgentSessionCatalogScopeOwned>
  }
) {
  return async (params: AgentModelCatalogReadParams): Promise<AgentSessionModelCatalogResult> => {
    const { deps, serialize, scopeOwned } = context()
    const catalog = deps.modelCatalog
    if (!catalog) {
      return { origin: 'unknown' }
    }
    const operation = catalog.captureRead(params)
    const id = params.sessionId
    const records =
      id === undefined
        ? undefined
        : await withinAgentModelCatalogRead(operation, () =>
            serialize(id, () =>
              operation.current() ? scopeOwned({ ...params, operation }) : Promise.resolve(null)
            ).catch(() => null)
          )
    if (
      !operation.current() ||
      records === null ||
      (params.sessionId !== undefined && records === undefined)
    ) {
      return { origin: 'unknown' }
    }
    const request = { ...params, records, operation, deadline: operation.deadline }
    if (!params.savedOnly) {
      void catalog.demand(request)
    }
    return catalog.read(request)
  }
}
