import { onLiveAccount } from './agent-model-catalog-running-account'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { readAccountList } from './agent-model-catalog-account-list'
import { captureAgentModelCatalogRead } from './agent-model-catalog-operation'
import {
  createAgentModelCatalogLookup,
  type AgentModelCatalogClaims
} from './agent-model-catalog-lookup'
import { createAgentModelCatalogLiveListings } from './agent-model-catalog-live-listings'
import { prewarmAgentModelCatalog } from './agent-model-catalog-prewarm'
import { agentModelCatalogSessionPeek } from './agent-model-catalog-session-peek'

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
  const tasks = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)

  const bindings = new Map<string, AgentModelCatalogBinding>()
  const claims: AgentModelCatalogClaims = new Map()
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
    // In progress while a reader of this request still waits on its own claim.
    (params, bound) => {
      const identity = bound ? undefined : capture(params)
      for (const claim of claims.get(requestKey(params)) ?? []) {
        if (claim.current() && (identity === undefined || claim.identity === identity)) {
          return true
        }
      }
      return false
    },
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
    captureRead,
    tasks
  )
  return {
    captureRead,
    snapshot,
    demand: async (params) => {
      if (!params.savedOnly) {
        await resolve(params)?.promise
      }
    },
    async prepareSaved(params) {
      if (!memoryBinding(params)) {
        await resolve({ ...params, savedOnly: true })?.promise
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
    async stop() {
      lifetime.abort()
      unbindRetirement()
      retireContext()
      deps.store.clearPartialAttempts()
      await Promise.allSettled(tasks)
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
