import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import { agentModelCatalogRequestKey } from './agent-model-catalog-snapshot'
import {
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  runAgentModelCatalogOperation
} from './agent-model-catalog-listing-waiters'

export type AgentModelCatalogReadOperation = {
  deadline?: number
  retirement: number
  workspaceIdentity?: unknown
  signal: AbortSignal
  current: () => boolean
  controller: AbortController
}

/** Capture the original invocation before the caller awaits its receiving owner. */
export function captureAgentModelCatalogRead(
  deps: AgentModelCatalogServiceDeps,
  lifetime: AbortSignal,
  params: AgentModelCatalogReadParams
): AgentModelCatalogReadOperation {
  const deadline =
    params.deadline ??
    (!params.savedOnly ? Date.now() + AGENT_MODEL_CATALOG_PICKER_WAIT_MS : undefined)
  const retirement = deps.store.retirementRevision(params.agent)
  const workspaceIdentity = params.workspace?.identity()
  const original = { ...params, records: undefined, operation: undefined }
  const identity = agentModelCatalogRequestKey(deps, original)
  const controller = new AbortController()
  const signal = AbortSignal.any([lifetime, controller.signal])
  return {
    deadline,
    retirement,
    workspaceIdentity,
    signal,
    controller,
    current: () =>
      !signal.aborted &&
      (deadline === undefined || Date.now() < deadline) &&
      deps.store.retirementRevision(params.agent) === retirement &&
      (workspaceIdentity === null || params.workspace?.identity() === workspaceIdentity) &&
      agentModelCatalogRequestKey(deps, original) === identity
  }
}

/** Reuse the existing bounded operation while the host, rather than the core, acquires scope. */
export async function withinAgentModelCatalogRead<T>(
  operation: AgentModelCatalogReadOperation,
  read: () => Promise<T>
): Promise<T | undefined> {
  if (!operation.current()) {
    return undefined
  }
  let result: { value: T } | { error: unknown } | undefined
  const run = async () => {
    try {
      const value = await read()
      if (operation.current()) {
        result = { value }
      }
    } catch (error) {
      if (operation.current()) {
        result = { error }
      }
    }
  }
  if (operation.deadline === undefined) {
    await run()
  } else if (operation.current()) {
    await runAgentModelCatalogOperation(
      run,
      operation.deadline - Date.now(),
      operation.controller,
      () => {}
    )
  }
  if (!operation.current() || !result) {
    return undefined
  }
  if ('error' in result) {
    throw result.error
  }
  return result.value
}
