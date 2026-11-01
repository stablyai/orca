import { seedAccountList } from './agent-model-catalog-account-list'
import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import type { AgentModelCatalogReadOperation } from './agent-model-catalog-operation'
import { agentModelCatalogReadRecords } from './agent-model-catalog-read-scope'
import { recordCatalogKey } from './agent-model-catalog-fingerprint'
import { scopedAgentModelCatalogLister } from './agent-model-catalog-lister'
import { newChatCatalogKey } from './agent-model-catalog-prewarm'
import {
  catalogFolder,
  sessionWorkspacePath,
  projectAgentModelCatalogDefault
} from './agent-model-catalog-workspace'
import { resolveAgentModelCatalogScope } from './agent-model-catalog-scope'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import {
  agentModelCatalogReleasedOwner,
  bindAgentModelCatalogScope,
  type AgentModelCatalogBinding
} from './agent-model-catalog-snapshot'
import {
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  runAgentModelCatalogOperation
} from './agent-model-catalog-listing-waiters'

export type AgentModelCatalogClaim = Pick<
  AgentModelCatalogBinding,
  'identity' | 'params' | 'current'
> & {
  controller: AbortController
  promise: Promise<void>
  ready: Promise<void>
}

export function createAgentModelCatalogLookup(
  deps: AgentModelCatalogServiceDeps,
  lifetime: AbortController,
  admission: PrioritySemaphore,
  bindings: Map<string, AgentModelCatalogBinding>,
  claims: Map<string, AgentModelCatalogClaim>,
  requestKey: (params: AgentModelCatalogReadParams) => string,
  capture: (params: AgentModelCatalogReadParams) => string,
  captureRead: (params: AgentModelCatalogReadParams) => AgentModelCatalogReadOperation
) {
  return (params: AgentModelCatalogReadParams): Promise<void> => {
    const operation = params.operation ?? captureRead(params)
    const deadline = operation.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS
    const remaining = deadline - Date.now()
    if (!operation.current() || remaining <= 0) {
      return Promise.resolve()
    }
    const bindingKey = requestKey(params)
    const key = params.savedOnly ? `${bindingKey}:saved` : bindingKey
    let identity = capture(params)
    const workspaceIdentity = operation.workspaceIdentity
    let coldWorkspace = params.workspace !== undefined && workspaceIdentity === null
    const retirement = operation.retirement
    const previous = claims.get(key)
    if (previous?.identity === identity) {
      return previous.promise
    }
    previous?.controller.abort()
    const controller = operation.controller
    const ready = Promise.withResolvers<void>()
    const valid = (): boolean =>
      Date.now() < deadline &&
      !controller.signal.aborted &&
      !lifetime.signal.aborted &&
      operation.current() &&
      deps.store.retirementRevision(params.agent) === retirement &&
      requestKey(params) === bindingKey &&
      (coldWorkspace || capture(params) === identity)
    const current = (): boolean => valid() && claims.get(key)?.controller === controller
    const run = async (): Promise<void> => {
      if (!current()) {
        return
      }
      const records = agentModelCatalogReadRecords(deps, params)
      if (!records) {
        return
      }
      const { record, scoped } = records
      const savedOnly = params.savedOnly || records.savedOnly
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
      const account = scoped
        ? recordCatalogKey(scoped, folder)
        : await newChatCatalogKey(deps, params.agent, folder)
      if (!current() || !account) {
        return
      }
      const { fingerprint: base, accountHome: probeHome } = account
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
        fingerprint: base,
        base,
        exact: false,
        folder,
        workspacePath,
        keepDefault:
          workspacePath === undefined ||
          (workspacePath === null && independentAgentModelCatalog(params.agent))
      }
      // Prewarm proves the selected account before command/folder resolution can finish.
      if (
        independentAgentModelCatalog(params.agent) &&
        !scoped &&
        workspacePath === undefined &&
        !params.legacy &&
        !savedOnly
      ) {
        bindAgentModelCatalogScope(bindings, bindingKey, bound, requestKey, true)
      }
      const scope = await resolveAgentModelCatalogScope(
        deps,
        { ...params, workspacePath, savedOnly },
        scoped,
        base,
        probeHome,
        current,
        { deadline, current, signal: AbortSignal.any([controller.signal, operation.signal]) }
      )
      if (!current() || !scope) {
        return
      }
      const { fingerprint, exact, resolved, cwd } = scope
      Object.assign(bound, { fingerprint, exact, cwd })
      bindAgentModelCatalogScope(bindings, bindingKey, bound, requestKey)
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
      const signal = AbortSignal.any([lifetime.signal, controller.signal, operation.signal])
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
      if (current()) {
        seedAccountList(deps, scope, params.agent)
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
}
