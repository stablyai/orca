import { captureAgentModelCatalogRead } from './agent-model-catalog-operation'
import {
  createAgentModelCatalogLookup,
  type AgentModelCatalogClaim
} from './agent-model-catalog-lookup'
import { createAgentModelCatalogLiveListings } from './agent-model-catalog-live-listings'
import { prewarmAgentModelCatalog } from './agent-model-catalog-prewarm'

import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogService,
  AgentModelCatalogReadParams
} from './agent-model-catalog-service-contract'
export type { AgentModelCatalogServiceDeps, AgentModelCatalogService }
import { onAtRestCommandContextRetired } from '../agent-session-wire/at-rest-command-context'
import {
  createAgentModelCatalogSnapshot,
  agentModelCatalogRequestKey,
  agentModelCatalogScopeIdentity,
  retireAgentModelCatalogRequests,
  agentModelCatalogMemoryBinding,
  expireAgentModelCatalogBoundFailure,
  agentModelCatalogSessionPeek,
  type AgentModelCatalogBinding
} from './agent-model-catalog-snapshot'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import {
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  waitForAgentModelCatalogRead
} from './agent-model-catalog-listing-waiters'

export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)

  const bindings = new Map<string, AgentModelCatalogBinding>()
  const claims = new Map<string, AgentModelCatalogClaim>()
  const requestKey = agentModelCatalogRequestKey.bind(null, deps)
  const capture = agentModelCatalogScopeIdentity.bind(null, deps)
  const retireContext = (workspaceId?: string, sources = true): void => {
    if (sources) {
      live.retireContext(workspaceId)
    }
    retireAgentModelCatalogRequests(deps, bindings, claims, workspaceId)
  }
  const live = createAgentModelCatalogLiveListings(deps, lifetime.signal)
  const unbindRetirement = onAtRestCommandContextRetired((workspaceId) =>
    retireContext(workspaceId, workspaceId !== undefined)
  )
  const memoryBinding = (params: AgentModelCatalogReadParams) =>
    agentModelCatalogMemoryBinding(deps, params, bindings, capture)
  const snapshot = createAgentModelCatalogSnapshot(
    deps,
    memoryBinding,
    (params, bound) =>
      bound
        ? claims.has(requestKey(params))
        : claims.get(requestKey(params))?.identity === capture(params),
    () => lifetime.signal.aborted
  )

  const captureRead = (params: AgentModelCatalogReadParams) =>
    captureAgentModelCatalogRead(deps, lifetime.signal, params)
  const resolve = createAgentModelCatalogLookup(
    deps,
    lifetime,
    admission,
    bindings,
    claims,
    requestKey,
    capture,
    captureRead
  )
  return {
    captureRead,
    snapshot,
    demand: (params) => (params.savedOnly ? Promise.resolve() : resolve(params)),
    async prepareSaved(params) {
      if (!memoryBinding(params)) {
        await resolve({ ...params, savedOnly: true })
      }
      return snapshot({ ...params, savedOnly: true })
    },
    captureSource: live.captureSource,
    retireContext,
    peek: agentModelCatalogSessionPeek(deps, memoryBinding),
    providerStarted(record, source) {
      expireAgentModelCatalogBoundFailure(deps, bindings, record, source)
      live.providerStarted(record, source)
    },
    async read(params) {
      if (!params.savedOnly && params.waitForListing) {
        const deadline = params.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS
        await waitForAgentModelCatalogRead({
          params: { ...params, deadline },
          store: deps.store,
          resolve,
          claim: () => claims.get(requestKey(params)),
          binding: () => bindings.get(requestKey(params))
        })
      }
      return snapshot(params)
    },
    recordLiveListing: live.recordLiveListing,
    async prewarm() {
      await prewarmAgentModelCatalog(deps, lifetime.signal, (params) => this.read(params))
    },
    stop() {
      lifetime.abort()
      unbindRetirement()
      retireContext()
      deps.store.clearPartialAttempts()
    }
  }
}
