import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogLiveListings } from './agent-model-catalog-live-listings'
import { scopedAgentModelCatalogLister } from './agent-model-catalog-lister'
import { prewarmAgentModelCatalog, newChatCatalogKey } from './agent-model-catalog-prewarm'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import {
  catalogFolder,
  sessionWorkspacePath,
  projectAgentModelCatalogDefault
} from './agent-model-catalog-workspace'

import type {
  AgentModelCatalogServiceDeps,
  AgentModelCatalogService,
  AgentModelCatalogReadParams
} from './agent-model-catalog-service-contract'
export type { AgentModelCatalogServiceDeps, AgentModelCatalogService }
import { resolveAgentModelCatalogScope } from './agent-model-catalog-scope'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { onAtRestCommandContextRetired } from '../agent-session-wire/at-rest-command-context'
import {
  createAgentModelCatalogSnapshot,
  agentModelCatalogRequestKey,
  agentModelCatalogReleasedOwner,
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
  runAgentModelCatalogOperation,
  waitForAgentModelCatalogRead
} from './agent-model-catalog-listing-waiters'

export function createAgentModelCatalogService(
  deps: AgentModelCatalogServiceDeps
): AgentModelCatalogService {
  const lifetime = new AbortController()
  const admission = new PrioritySemaphore(2)

  type Claim = Pick<AgentModelCatalogBinding, 'identity' | 'params' | 'current'> & {
    controller: AbortController
    promise: Promise<void>
    ready: Promise<void>
  }
  const bindings = new Map<string, AgentModelCatalogBinding>()
  const claims = new Map<string, Claim>()
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

  const resolve = (params: AgentModelCatalogReadParams): Promise<void> => {
    const deadline = params.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS
    const remaining = deadline - Date.now()
    if (lifetime.signal.aborted || remaining <= 0) {
      return Promise.resolve()
    }
    const bindingKey = requestKey(params)
    const key = params.savedOnly ? `${bindingKey}:saved` : bindingKey
    let identity = capture(params)
    const workspaceIdentity = params.workspace?.identity()
    let coldWorkspace = params.workspace !== undefined && workspaceIdentity === null
    const retirement = deps.store.retirementRevision(params.agent)
    const previous = claims.get(key)
    if (previous?.identity === identity) {
      return previous.promise
    }
    previous?.controller.abort()
    const controller = new AbortController()
    const ready = Promise.withResolvers<void>()
    const valid = (): boolean =>
      Date.now() < deadline &&
      !controller.signal.aborted &&
      !lifetime.signal.aborted &&
      deps.store.retirementRevision(params.agent) === retirement &&
      requestKey(params) === bindingKey &&
      (coldWorkspace || capture(params) === identity)
    const current = (): boolean => valid() && claims.get(key)?.controller === controller
    const run = async (): Promise<void> => {
      if (!current()) {
        return
      }
      const record = params.sessionId ? deps.getConversation(params.sessionId) : undefined
      const savedOnly = params.savedOnly || !!(record && !deps.getRecord(record.sessionId))
      const scoped =
        record && record.provider === params.agent && deps.drivesRecord(record) ? record : undefined
      if (record && !scoped) {
        return
      }
      let workspacePath: string | null | undefined
      if (params.workspace) {
        const resolved = await params.workspace.resolve().catch(() => undefined)
        if (!current() || resolved === undefined) {
          return
        }
        if (resolved !== null && typeof resolved === 'object') {
          if (
            resolved.identity === null ||
            params.workspace.identity() !== resolved.identity ||
            (!coldWorkspace && workspaceIdentity !== resolved.identity)
          ) {
            return
          }
          identity = capture(params)
          const claim = claims.get(key)
          if (claim?.controller !== controller) {
            return
          }
          claim.identity = identity
          workspacePath = resolved.path
        } else {
          workspacePath = resolved
        }
        coldWorkspace = false
      } else {
        workspacePath =
          params.inSessionWorkspace ||
          (record &&
            params.workspacePath === undefined &&
            !params.legacy &&
            deps.agentReadsProjectModelConfig?.(params.agent) === true)
            ? record
              ? await sessionWorkspacePath(deps, record)
              : null
            : params.workspacePath
      }
      if (!current()) {
        return
      }
      const folder = await catalogFolder(deps, params.agent, workspacePath, scoped)
      if (!current()) {
        return
      }
      let fingerprint: string
      let probeHome: AgentSessionAccountHome | null
      if (scoped) {
        fingerprint = agentModelCatalogFingerprintForRecord(scoped, folder)
        // Native probes cannot list a WSL-pinned account.
        probeHome =
          scoped.location.executionHostId === 'local' && scoped.location.wslDistro === null
            ? scoped.accountHome
            : null
      } else {
        const key = await newChatCatalogKey(deps, params.agent, folder)
        if (!current() || !key) {
          return
        }
        fingerprint = key.fingerprint
        probeHome = key.accountHome
      }
      const scope = await resolveAgentModelCatalogScope(
        deps,
        { ...params, workspacePath, savedOnly },
        scoped,
        fingerprint,
        probeHome,
        current,
        { deadline, current, signal: controller.signal }
      )
      if (!current() || !scope) {
        return
      }
      const { base, exact, resolved, cwd } = scope
      fingerprint = scope.fingerprint
      let bindingCurrent = true
      const bound: AgentModelCatalogBinding = {
        identity,
        params,
        current: () =>
          bindingCurrent &&
          !lifetime.signal.aborted &&
          deps.store.retirementRevision(params.agent) === retirement,
        workspaceId: record?.location.workspaceId,
        cancel: () => {
          bindingCurrent = false
          controller.abort()
        },
        fingerprint,
        base,
        exact,
        folder,
        cwd,
        workspacePath,
        keepDefault:
          workspacePath === undefined ||
          (workspacePath === null && independentAgentModelCatalog(params.agent))
      }
      bindings.set(bindingKey, bound)
      while (bindings.size > 256) {
        const oldest = bindings.keys().next().value
        if (oldest !== undefined) {
          bindings.delete(oldest)
        }
      }
      bound.projecting = projectAgentModelCatalogDefault(
        deps,
        params.agent,
        bound,
        probeHome,
        () => valid() && bindings.get(bindingKey) === bound
      )
      if (savedOnly) {
        await bound.projecting
        return
      }
      if (!exact && agentModelCatalogReleasedOwner(scoped)) {
        return
      }
      const probe = deps.probes?.[params.agent]
      const signal = AbortSignal.any([lifetime.signal, controller.signal])
      const list = scopedAgentModelCatalogLister({
        legacy: params.legacy,
        operation: { deadline, current, signal },
        canList: () => !record || !!deps.getRecord(record.sessionId),
        admission,
        signal,
        resolved,
        probe,
        probeHome,
        workspacePath: cwd ?? folder
      })
      if (probe && probeHome && deps.store.probeDue(fingerprint)) {
        void deps.store.refresh(fingerprint, params.agent, list, current, signal)
      }
      // Demand owns ingestion until settlement, even when its caller only needs the snapshot.
      ready.resolve()
      const pending = deps.store.pendingListing(fingerprint, true, true)
      if (pending) {
        await pending
      }
    }
    const promise = runAgentModelCatalogOperation(run, remaining, controller, () => {
      ready.resolve()
      if (claims.get(key)?.controller === controller) {
        claims.delete(key)
      }
    })
    claims.set(key, { identity, controller, promise, ready: ready.promise, params, current })
    return promise
  }
  return {
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
