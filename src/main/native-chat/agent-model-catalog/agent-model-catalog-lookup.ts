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
import {
  independentAgentModelCatalog,
  usesModelSpecificAcpEfforts
} from '../../../shared/agent-session/options/agent-model-catalog-ownership'
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
  deadline: number
  controller: AbortController
  promise: Promise<void>
  ready: Promise<void>
  demandModel: (model: string | undefined) => void
}

export function createAgentModelCatalogLookup(
  deps: AgentModelCatalogServiceDeps,
  lifetime: AbortController,
  admission: PrioritySemaphore,
  bindings: Map<string, AgentModelCatalogBinding>,
  claims: Map<string, AgentModelCatalogClaim>,
  requestKey: (params: AgentModelCatalogReadParams) => string,
  capture: (params: AgentModelCatalogReadParams) => string,
  captureRead: (params: AgentModelCatalogReadParams) => AgentModelCatalogReadOperation,
  tasks: Set<Promise<unknown>>
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
    const identity = capture(params)
    const retirement = operation.retirement
    const previous = claims.get(key)
    const selectedModel = usesModelSpecificAcpEfforts(params.agent)
      ? (params.selectedModel ??
        (params.sessionId ? deps.getConversation(params.sessionId)?.options?.model : undefined))
      : undefined
    // A later reader with more time left starts its own claim, which joins the same listing.
    if (previous?.identity === identity && previous.deadline >= deadline) {
      previous.demandModel(selectedModel)
      return previous.promise
    }
    // The same request with more time left takes over; it joins the listing the earlier one
    // started, so the earlier one just runs out on its own deadline.
    if (previous?.identity !== identity) {
      previous?.controller.abort()
    }
    const controller = operation.controller
    let target = selectedModel
    let targetFingerprint: string | undefined
    const demandModel = (model: string | undefined) => {
      target = model
      if (targetFingerprint) {
        deps.store.efforts.demand(targetFingerprint, model)
      }
    }
    const ready = Promise.withResolvers<void>()
    const valid = (): boolean =>
      Date.now() < deadline &&
      !controller.signal.aborted &&
      !lifetime.signal.aborted &&
      operation.current() &&
      deps.store.retirementRevision(params.agent) === retirement &&
      requestKey(params) === bindingKey &&
      capture(params) === identity
    // A same-request claim with more time left doesn't retire this one; a different request does.
    const current = (): boolean =>
      valid() &&
      (claims.get(key)?.controller === controller || claims.get(key)?.identity === identity)
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
      const workspacePath =
        params.inSessionWorkspace ||
        (record &&
          params.workspacePath === undefined &&
          !params.legacy &&
          (independentAgentModelCatalog(params.agent) ||
            deps.agentReadsProjectModelConfig?.(params.agent) === true))
          ? record
            ? await sessionWorkspacePath(deps, record)
            : null
          : params.workspacePath
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
        // A workspace that was named but cannot be inspected here may pick its own model.
        keepDefault: workspacePath === undefined,
        keepEffort: workspacePath === undefined
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
      targetFingerprint = fingerprint
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
      // A listing is shared by every reader of its scope and lives while any of them still wants
      // it (the store counts each reader's demand); its process runs only under the service.
      const signal = AbortSignal.any([lifetime.signal, controller.signal, operation.signal])
      const list = scopedAgentModelCatalogLister({
        legacy: params.legacy,
        operation: { deadline, current, signal },
        // A chat's deletion doesn't stop a listing other chats or folders share.
        canList: () => resolved !== undefined || !record || !!deps.getRecord(record.sessionId),
        admission,
        signal: lifetime.signal,
        resolved,
        probe,
        probeHome,
        workspacePath: cwd ?? folder
      })
      if (
        probe &&
        probeHome &&
        (deps.store.probeDue(fingerprint) ||
          deps.store.efforts.due(fingerprint, target) ||
          deps.store.isListing(fingerprint))
      ) {
        void deps.store.refresh(
          fingerprint,
          params.agent,
          (selected, owner) => {
            const task = list(selected, owner)
            tasks.add(task)
            void task.finally(() => tasks.delete(task)).catch(() => {})
            return task
          },
          { current, signal, deadline },
          target
        )
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
    tasks.add(promise)
    void promise.finally(() => tasks.delete(promise)).catch(() => {})
    claims.set(key, {
      identity,
      deadline,
      controller,
      promise,
      ready: ready.promise,
      params,
      current,
      demandModel
    })
    return promise
  }
}
