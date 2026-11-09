import { onLiveAccount } from './agent-model-catalog-running-account'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { readAccountList } from './agent-model-catalog-account-list'
import { captureAgentModelCatalogRead } from './agent-model-catalog-operation'
import { createAgentModelCatalogLookup } from './agent-model-catalog-lookup'
import { createAgentModelCatalogRefreshes } from './agent-model-catalog-refresh'
import { createAgentModelCatalogLiveListings } from './agent-model-catalog-live-listings'
import { prewarmAgentModelCatalog } from './agent-model-catalog-prewarm'
import { agentModelCatalogSessionPeek } from './agent-model-catalog-session-peek'

import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogService,
  AgentModelCatalogReadParams
} from './agent-model-catalog-service-contract'
export type { AgentModelCatalogServiceDeps, AgentModelCatalogService }
import { onAtRestCommandContextRetired } from '../agent-session-wire/options/at-rest-command-context'
import {
  createAgentModelCatalogSnapshot,
  agentModelCatalogRequestKey,
  agentModelCatalogScopeIdentity,
  retireAgentModelCatalogBindings,
  agentModelCatalogMemoryBinding,
  type AgentModelCatalogBinding
} from './agent-model-catalog-snapshot'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import {
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  waitForAgentModelCatalogRead,
  waitWithinAgentModelCatalogRead
} from './agent-model-catalog-listing-waiters'

export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  const tasks = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)

  const bindings = new Map<string, AgentModelCatalogBinding>()
  const requestKey = agentModelCatalogRequestKey.bind(null, deps)
  const capture = agentModelCatalogScopeIdentity.bind(null, deps)
  const refreshes = createAgentModelCatalogRefreshes({
    deps,
    lifetime: lifetime.signal,
    admission,
    bindings,
    requestKey,
    tasks
  })
  const lookup = createAgentModelCatalogLookup(deps, refreshes, requestKey, capture)
  const retireContext = (workspaceId?: string, sources = true): void => {
    if (sources) {
      live.retireContext(workspaceId)
    }
    retireAgentModelCatalogBindings(bindings, workspaceId)
    refreshes.retire(workspaceId)
  }
  const live = createAgentModelCatalogLiveListings(deps, lifetime.signal)
  const unbindRetirement = onAtRestCommandContextRetired((workspaceId) =>
    retireContext(workspaceId, workspaceId !== undefined)
  )
  const memoryBinding = (params: AgentModelCatalogReadParams) =>
    agentModelCatalogMemoryBinding(deps, params, bindings, capture)
  // In progress while a refresh this read would join still runs.
  const snapshot = createAgentModelCatalogSnapshot(
    deps,
    memoryBinding,
    (params) => lookup.pending(params),
    () => lifetime.signal.aborted
  )

  const captureRead = (params: AgentModelCatalogReadParams) =>
    captureAgentModelCatalogRead(deps, lifetime.signal, params)
  // The read asks for the shared refresh and waits on it only within its own budget.
  const demand = async (params: AgentModelCatalogReadParams): Promise<void> => {
    const operation = params.operation ?? captureRead(params)
    await waitWithinAgentModelCatalogRead(operation, lookup.request(params, operation)?.done)
  }
  return {
    captureRead,
    snapshot,
    demand: async (params) => {
      if (!params.savedOnly) {
        await demand(params)
      }
    },
    async prepareSaved(params) {
      if (!memoryBinding(params)) {
        await demand({ ...params, savedOnly: true })
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
      const waits = !params.savedOnly && params.waitForListing
      const deadline = params.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS
      if (waits) {
        const operation = params.operation ?? captureRead({ ...params, deadline })
        await waitForAgentModelCatalogRead({
          params,
          reader: { deadline, signal: operation.signal },
          store: deps.store,
          refresh: lookup.request(params, operation),
          binding: () => bindings.get(requestKey(params))
        })
      }
      const result = snapshot(params)
      // A waiting read that used its whole budget is final; work still running doesn't reopen it.
      const { listingInProgress: _, ...settled } = result
      const answer = waits && Date.now() >= deadline ? settled : result
      return lifetime.signal.aborted
        ? answer
        : readAccountList(deps, params, answer, () => memoryBinding({ agent: params.agent })?.base)
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
