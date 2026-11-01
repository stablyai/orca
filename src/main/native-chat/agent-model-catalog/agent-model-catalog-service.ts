import { onLiveAccount } from './agent-model-catalog-running-account'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { readAccountList } from './agent-model-catalog-account-list'
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
      const result = snapshot(params)
      return lifetime.signal.aborted
        ? result
        : readAccountList(deps, params, result, () => memoryBinding({ agent: params.agent })?.base)
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

/** The invocation-qualified binding may differ from a live listing's account key. */
function expireAgentModelCatalogBoundFailure(
  deps: AgentModelCatalogServiceDeps,
  bindings: ReadonlyMap<string, AgentModelCatalogBinding>,
  record: AgentSessionRecord,
  source?: () => boolean
): void {
  const view = agentSessionConversationView(record)
  const bound = bindings.get(
    agentModelCatalogRequestKey(deps, {
      agent: record.provider,
      sessionId: record.sessionId,
      inSessionWorkspace: true,
      records: { record: view, scoped: onLiveAccount(deps, view), savedOnly: false }
    })
  )
  if (bound?.current() && source?.() !== false) {
    deps.store.expireFailure(bound.fingerprint)
  }
}
