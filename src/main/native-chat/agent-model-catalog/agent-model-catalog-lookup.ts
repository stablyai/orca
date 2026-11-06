import { seedAccountList } from './agent-model-catalog-account-list'
import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import type { AgentModelCatalogReadOperation } from './agent-model-catalog-operation'
import { agentModelCatalogReadRecords } from './agent-model-catalog-read-scope'
import { recordCatalogKey } from './agent-model-catalog-fingerprint'
import {
  scopedAgentModelCatalogLister,
  type AgentModelCatalogListingDemand
} from './agent-model-catalog-lister'
import { newChatCatalogKey } from './agent-model-catalog-prewarm'
import { agentModelCatalogClaimReaders } from './agent-model-catalog-claim-readers'
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
  controller: AbortController
  promise: Promise<void>
  ready: Promise<void>
  demandModel: (model: string | undefined) => void
  /** Another reader of the same request wants this claim's listing until its own deadline. */
  join: (demand: AgentModelCatalogListingDemand) => void
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
    const reader = { current: operation.current, signal: operation.signal, deadline }
    // Every reader of the same request shares one claim, which lives until its last reader's
    // deadline, so later readers neither repeat its setup nor lose its listing.
    if (previous?.identity === identity && previous.current?.() !== false) {
      previous.demandModel(selectedModel)
      previous.join(reader)
      return previous.promise
    }
    previous?.controller.abort()
    // The claim's own: retirement, a different request or its last reader leaving ends it.
    const controller = new AbortController()
    const readers = agentModelCatalogClaimReaders(controller)
    let listing: string | undefined
    const join = (entry: AgentModelCatalogListingDemand): void => {
      readers.add(entry)
      if (listing) {
        deps.store.isListing(listing, readers.ownership(entry, current))
      }
    }
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
      !controller.signal.aborted &&
      !lifetime.signal.aborted &&
      readers.any() &&
      deps.store.retirementRevision(params.agent) === retirement
    const current = (): boolean => valid() && claims.get(key)?.controller === controller
    // Bounded work below runs until the last reader's deadline, however late it joined.
    const bounded = {
      current,
      signal: AbortSignal.any([lifetime.signal, controller.signal]),
      get deadline() {
        return readers.latest()
      }
    }
    join(reader)
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
        bounded
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
      const list = scopedAgentModelCatalogLister({
        legacy: params.legacy,
        operation: bounded,
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
        const [first, ...rest] = readers.all()
        void deps.store.refresh(
          fingerprint,
          params.agent,
          (selected, owner) => {
            const task = list(selected, owner)
            tasks.add(task)
            void task.finally(() => tasks.delete(task)).catch(() => {})
            return task
          },
          first && readers.ownership(first, current),
          target
        )
        listing = fingerprint
        for (const entry of rest) {
          deps.store.isListing(fingerprint, readers.ownership(entry, current))
        }
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
    const promise = runAgentModelCatalogOperation(
      run,
      () => readers.latest() - Date.now(),
      controller,
      () => {
        ready.resolve()
        readers.clear()
        if (claims.get(key)?.controller === controller) {
          claims.delete(key)
        }
      }
    )
    tasks.add(promise)
    void promise.finally(() => tasks.delete(promise)).catch(() => {})
    claims.set(key, {
      identity,
      controller,
      promise,
      ready: ready.promise,
      params,
      current,
      demandModel,
      join
    })
    return promise
  }
}
