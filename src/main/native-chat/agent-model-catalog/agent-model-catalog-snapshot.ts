import {
  agentModelCatalogReadRecords,
  agentModelCatalogScopedRecord
} from './agent-model-catalog-read-scope'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session/records/agent-session-record-launch-directory'
import type { AgentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session/agent-session-wire'
import { agentModelCatalogResultFromEntry } from './agent-model-catalog-entry'
import { agentModelCatalogDefaultFollowsAccount } from './agent-model-catalog-workspace'
import {
  independentAgentModelCatalog,
  usesModelSpecificAcpEfforts
} from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

/** A request's resolved scope: lookup and projection data that owns no work. */
export type AgentModelCatalogBinding = {
  identity: string
  agent: string
  legacy?: boolean
  /** Whether the chat it was resolved for runs on this machine (or it had none). */
  local: boolean
  workspaceId?: string
  current: () => boolean
  fingerprint: string
  base: string
  exact: boolean
  folder?: string
  cwd?: string
  workspacePath?: string | null
  keepDefault: boolean
  projecting?: Promise<void>
}

/** Canonical authority survives folder churn and preliminary same-account refreshes until replacement. */
export function bindAgentModelCatalogScope(
  bindings: Map<string, AgentModelCatalogBinding>,
  key: string,
  bound: AgentModelCatalogBinding,
  requestKey: (params: AgentModelCatalogReadParams) => string,
  preliminary = false
): void {
  const held = preliminary ? bindings.get(key) : undefined
  if (held?.current() && held.identity === bound.identity && held.base === bound.base) {
    return
  }
  bindings.set(key, bound)
  const canonical = ['claude', 'codex'].map((agent) => requestKey({ agent }))
  const limit = 256 + canonical.filter((key) => bindings.has(key)).length
  if (bindings.size <= limit) {
    return
  }
  for (const candidate of bindings.keys()) {
    if (!canonical.includes(candidate)) {
      bindings.delete(candidate)
      if (bindings.size <= limit) {
        break
      }
    }
  }
}

export function agentModelCatalogReleasedOwner(
  record: AgentSessionConversationView | undefined
): boolean {
  return (
    record?.ownerObservation.claimStatus === 'released' && !!record.ownerObservation.deathEvidence
  )
}

export function agentModelCatalogRequestKey(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams
): string {
  const record = agentModelCatalogScopedRecord(deps, params)
  const inWorkspace =
    record &&
    params.workspacePath === undefined &&
    (params.inSessionWorkspace ||
      deps.listsInChatFolder?.has(params.agent) ||
      ((independentAgentModelCatalog(params.agent) ||
        deps.agentReadsProjectModelConfig?.(params.agent) === true) &&
        !params.legacy))
  return JSON.stringify({
    agent: params.agent,
    account: record && [
      record.provider,
      record.accountHome,
      record.location.executionHostId,
      record.location.wslDistro,
      deps.drivesRecord(record)
    ],
    released: agentModelCatalogReleasedOwner(record),
    workspacePath: params.workspacePath,
    inSessionWorkspace:
      inWorkspace && record ? [record.location.workspaceId, record.launchDirectory] : undefined,
    legacy: params.legacy
  })
}

export function agentModelCatalogScopeIdentity(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams
): string {
  return JSON.stringify([
    deps.store.retirementRevision(params.agent),
    agentModelCatalogRequestKey(deps, params)
  ])
}

export function agentModelCatalogMemoryBinding(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  bindings: ReadonlyMap<string, AgentModelCatalogBinding>,
  capture: (params: AgentModelCatalogReadParams) => string
): AgentModelCatalogBinding | undefined {
  if (!agentModelCatalogReadRecords(deps, params)) {
    return
  }
  const held = bindings.get(agentModelCatalogRequestKey(deps, params))
  if (held?.current() && held.identity === capture(params)) {
    return held
  }
  const record = agentModelCatalogScopedRecord(deps, params)
  if (!record || record.provider !== params.agent || !deps.drivesRecord(record)) {
    return
  }
  // Pinned native account and cwd can reuse a scope another caller already proved.
  const cwd =
    params.workspacePath === undefined
      ? agentSessionPinnedLaunchDirectory(record)
      : params.workspacePath
  if (cwd && record.location.executionHostId === 'local' && record.location.wslDistro === null) {
    for (const bound of bindings.values()) {
      if (
        bound.agent === params.agent &&
        !!bound.legacy === !!params.legacy &&
        (bound.workspacePath ?? bound.folder ?? bound.cwd) === cwd &&
        bound.local &&
        bound.base === agentModelCatalogFingerprintForRecord(record, bound.folder) &&
        bound.current()
      ) {
        return bound
      }
    }
  }
  if (
    deps.listsInChatFolder?.has(params.agent) ||
    (params.workspacePath !== null &&
      (independentAgentModelCatalog(params.agent) ||
        (deps.agentReadsProjectModelConfig?.(params.agent) === true && !params.legacy)))
  ) {
    return
  }
  const fingerprint = agentModelCatalogFingerprintForRecord(record)
  return {
    identity: capture(params),
    agent: params.agent,
    legacy: params.legacy,
    local: true,
    current: () => true,
    fingerprint,
    base: fingerprint,
    exact: false,
    keepDefault:
      agentModelCatalogDefaultFollowsAccount(params.agent) ||
      (!params.inSessionWorkspace && params.workspacePath === undefined) ||
      params.legacyOptionsDisplay === true ||
      deps.agentReadsProjectModelConfig?.(params.agent) === false
  }
}

export function createAgentModelCatalogSnapshot(
  deps: AgentModelCatalogServiceDeps,
  binding: (params: AgentModelCatalogReadParams) => AgentModelCatalogBinding | undefined,
  resolving: (params: AgentModelCatalogReadParams, bound: boolean) => boolean,
  stopped: () => boolean
) {
  return (params: AgentModelCatalogReadParams): AgentSessionModelCatalogResult => {
    if (params.records === null || params.operation?.current() === false) {
      return { origin: 'unknown' }
    }
    const bound = binding(params)
    if (stopped() || !bound) {
      return {
        origin: 'unknown',
        ...(!params.savedOnly && resolving(params, false)
          ? { listingInProgress: true as const }
          : {})
      }
    }
    return projectAgentModelCatalogSnapshot(deps, params, bound, resolving(params, true))
  }
}

export function projectAgentModelCatalogSnapshot(
  deps: AgentModelCatalogServiceDeps,
  params: AgentModelCatalogReadParams,
  bound: AgentModelCatalogBinding,
  resolving: boolean
): AgentSessionModelCatalogResult {
  const listed = deps.store.observation(bound.fingerprint)
  const independent = independentAgentModelCatalog(params.agent)
  if (
    params.verifiedOnly &&
    (!listed || (independent && (!bound.exact || !deps.store.verified(listed))))
  ) {
    return { origin: 'unknown' }
  }
  const display =
    listed ?? (bound.exact && !params.verifiedOnly ? deps.store.observation(bound.base) : null)
  const verified = bound.exact && listed !== null && deps.store.verified(listed)
  const result = display
    ? agentModelCatalogResultFromEntry(
        display,
        independent &&
          !params.legacyOptionsDisplay &&
          // The account's list stands in for this folder's; it names no default here.
          (display !== listed || !deps.store.verified(display) || (!bound.exact && !params.legacy))
          ? false
          : verified || bound.keepDefault,
        deps.listingNamesConfiguredModel?.has(params.agent) === true,
        !independent || verified
      )
    : null
  return {
    ...(result ?? { origin: 'unknown' }),
    ...(result?.listingNamesConfiguredModel &&
    deps.agentReadsProjectModelConfig?.(params.agent) === false
      ? { defaultHoldsInEveryWorkspace: true as const }
      : {}),
    ...(result && ((independent && !params.legacy) || bound.folder !== undefined || bound.exact)
      ? { modelsDifferByWorkspace: true as const }
      : {}),
    ...(!params.savedOnly &&
    !params.verifiedOnly &&
    (deps.store.isListing(bound.fingerprint) ||
      (resolving && deps.store.probeDue(bound.fingerprint))) &&
    (independent || !listed || usesModelSpecificAcpEfforts(params.agent))
      ? { listingInProgress: true as const }
      : {}),
    ...(deps.store.failure(bound.fingerprint)?.unavailable
      ? { unavailable: deps.store.failure(bound.fingerprint)?.unavailable }
      : {})
  }
}

/** Drops resolved scopes its agent retired, and (named) a workspace's; no work ends with them. */
export function retireAgentModelCatalogBindings(
  bindings: Map<string, AgentModelCatalogBinding>,
  workspaceId?: string
): void {
  for (const [key, bound] of bindings) {
    if (!bound.current() || (workspaceId !== undefined && bound.workspaceId === workspaceId)) {
      bindings.delete(key)
    }
  }
}
