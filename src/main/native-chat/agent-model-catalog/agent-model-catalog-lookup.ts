import type { PrioritySemaphore } from '../../../shared/priority-semaphore'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import type { AgentModelCatalogReadOperation } from './agent-model-catalog-operation'
import { scopedAgentModelCatalogLister } from './agent-model-catalog-lister'
import type { createAgentModelCatalogSetups } from './agent-model-catalog-setup'
import { agentModelCatalogReadRecords } from './agent-model-catalog-read-scope'
import { projectAgentModelCatalogDefault } from './agent-model-catalog-workspace'
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

/** One reader's claim: its own deadline and cancellation, from setup through the listing wait. */
export type AgentModelCatalogClaim = Pick<
  AgentModelCatalogBinding,
  'identity' | 'params' | 'current'
> & {
  controller: AbortController
  promise: Promise<void>
  ready: Promise<void>
}

/** Every reader's claim, by request; readers of one request share setup, never each other's life. */
export type AgentModelCatalogClaims = Map<string, Set<AgentModelCatalogClaim>>

export function createAgentModelCatalogLookup(
  deps: AgentModelCatalogServiceDeps,
  lifetime: AbortController,
  admission: PrioritySemaphore,
  bindings: Map<string, AgentModelCatalogBinding>,
  claims: AgentModelCatalogClaims,
  requestKey: (params: AgentModelCatalogReadParams) => string,
  capture: (params: AgentModelCatalogReadParams) => string,
  captureRead: (params: AgentModelCatalogReadParams) => AgentModelCatalogReadOperation,
  tasks: Set<Promise<unknown>>,
  setups: ReturnType<typeof createAgentModelCatalogSetups>
) {
  return (params: AgentModelCatalogReadParams): AgentModelCatalogClaim | undefined => {
    const operation = params.operation ?? captureRead(params)
    const deadline = operation.deadline ?? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS
    const remaining = deadline - Date.now()
    if (!operation.current() || remaining <= 0) {
      return undefined
    }
    const bindingKey = requestKey(params)
    const key = params.savedOnly ? `${bindingKey}:saved` : bindingKey
    const identity = capture(params)
    const retirement = operation.retirement
    const target = usesModelSpecificAcpEfforts(params.agent)
      ? (params.selectedModel ??
        (params.sessionId ? deps.getConversation(params.sessionId)?.options?.model : undefined))
      : undefined
    const controller = operation.controller
    const readers = claims.get(key) ?? new Set<AgentModelCatalogClaim>()
    claims.set(key, readers)
    const ready = Promise.withResolvers<void>()
    const valid = (): boolean =>
      Date.now() < deadline &&
      !controller.signal.aborted &&
      !lifetime.signal.aborted &&
      operation.current() &&
      deps.store.retirementRevision(params.agent) === retirement &&
      requestKey(params) === bindingKey &&
      capture(params) === identity
    const current = (): boolean => valid() && readers.has(claim)
    const signal = AbortSignal.any([lifetime.signal, controller.signal, operation.signal])
    const run = async (): Promise<void> => {
      // This reader's own chat decides whether it may list; only same-request readers that agree
      // on that share a setup. One that ran out of its budget leaves a reader time to start another.
      const records = agentModelCatalogReadRecords(deps, params)
      const own = records?.record
      const share = () => setups(`${key}\n${identity}\n${records?.savedOnly}`, params, deadline)
      let setup = share()
      let facts = await setup.account
      if (!facts && current() && setup.lapsed()) {
        setup = share()
        facts = await setup.account
      }
      if (!current() || !facts) {
        return
      }
      const { record, scoped, savedOnly, workspacePath, folder, base, probeHome } = facts
      let bindingCurrent = true
      const bound: AgentModelCatalogBinding = {
        identity,
        params,
        current: () =>
          bindingCurrent &&
          !lifetime.signal.aborted &&
          deps.store.retirementRevision(params.agent) === retirement,
        workspaceId: record?.location.workspaceId,
        // Scope facts only: retiring them never ends a reader's claim or a shared listing.
        cancel: () => {
          bindingCurrent = false
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
      let scope = await setup.scope
      if (!scope && current() && setup.lapsed()) {
        setup = share()
        scope = await setup.scope
      }
      if (!current() || !scope) {
        return
      }
      const { fingerprint, exact, resolved, cwd } = scope
      Object.assign(bound, { fingerprint, exact, cwd })
      bindAgentModelCatalogScope(bindings, bindingKey, bound, requestKey)
      bound.projecting = projectAgentModelCatalogDefault(
        params.agent,
        bound,
        setup.defaults,
        // The folder's settings are the binding's, whichever reader is still waiting for them.
        () => bound.current() && bindings.get(bindingKey) === bound
      )
      if (savedOnly) {
        await bound.projecting
        return
      }
      if (!exact && agentModelCatalogReleasedOwner(scoped)) {
        return
      }
      const probe = deps.probes?.[params.agent]
      const list = scopedAgentModelCatalogLister({
        legacy: params.legacy,
        operation: { deadline, current, signal },
        // A chat's deletion doesn't stop a listing other chats or folders share.
        canList: () => resolved !== undefined || !own || !!deps.getRecord(own.sessionId),
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
        // Each reader owns the shared listing until its own deadline or cancellation.
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
        setup.seed(params.agent, scope)
      }
    }
    const claim: AgentModelCatalogClaim = {
      identity,
      controller,
      promise: Promise.resolve(),
      ready: ready.promise,
      params,
      current
    }
    readers.add(claim)
    claim.promise = runAgentModelCatalogOperation(run, remaining, controller, () => {
      ready.resolve()
      readers.delete(claim)
      if (readers.size === 0 && claims.get(key) === readers) {
        claims.delete(key)
      }
    })
    tasks.add(claim.promise)
    void claim.promise.finally(() => tasks.delete(claim.promise)).catch(() => {})
    return claim
  }
}
