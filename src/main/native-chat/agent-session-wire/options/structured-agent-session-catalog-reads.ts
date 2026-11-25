import type { AgentModelCatalogReadParams } from '../../agent-model-catalog/agent-model-catalog-service-contract'
import { withinAgentModelCatalogRead } from '../../agent-model-catalog/agent-model-catalog-operation'
import { resolveAgentModelCatalogReadRecords } from '../../agent-model-catalog/agent-model-catalog-running-account'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { agentSessionAccountHomesEqual } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'

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
      launchAccountHome: async (record) => (await deps.launchAccountHome?.(record)) ?? null
    },
    params
  )
}

/** Named external reads acquire once, after capture and before nonacquiring preparation. */
export function createStructuredAgentSessionCatalogReads(
  context: () => {
    deps: Pick<StructuredAgentSessionHostDeps, 'modelCatalog'>
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
    const readScope = () =>
      id === undefined
        ? undefined
        : withinAgentModelCatalogRead(operation, () =>
            serialize(id, () =>
              operation.current() ? scopeOwned({ ...params, operation }) : Promise.resolve(null)
            ).catch(() => null)
          )
    const records = await readScope()
    if (
      !operation.current() ||
      records === null ||
      (params.sessionId !== undefined && records === undefined)
    ) {
      return { origin: 'unknown' }
    }
    const request = { ...params, records, operation, deadline: operation.deadline }
    if (!params.savedOnly && !params.waitForListing && !params.confirmSignIn) {
      void catalog.demand(request)
    }
    const result = await catalog.read(request)
    if (!result.signInConfirmed) {
      return result
    }
    const expected = records?.scoped?.accountHome
    const current = (await readScope())?.scoped?.accountHome
    if (expected && current && agentSessionAccountHomesEqual(expected, current)) {
      return result
    }
    const { signInConfirmed: _confirmation, ...inconclusive } = result
    return inconclusive
  }
}
