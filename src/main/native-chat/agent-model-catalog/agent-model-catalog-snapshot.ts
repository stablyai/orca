import {
  agentModelCatalogReadRecords,
  agentModelCatalogScopedRecord
} from './agent-model-catalog-read-scope'
import { onLiveAccount } from './agent-model-catalog-running-account'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import {
  agentSessionConversationView,
  type AgentSessionConversationView
} from '../../../shared/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { agentModelCatalogResultFromEntry } from './agent-model-catalog-entry'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import type {
  AgentModelCatalogReadParams,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'

export type AgentModelCatalogBinding = {
  identity: string
  params: AgentModelCatalogReadParams
  workspaceId?: string
  current: () => boolean
  cancel: () => void
  fingerprint: string
  base: string
  exact: boolean
  folder?: string
  cwd?: string
  workspacePath?: string | null
  keepDefault: boolean
  projecting?: Promise<void>
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
    !params.workspace &&
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
    selector: params.workspace?.selector,
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
    params.workspace?.identity(),
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
  const cwd = params.workspace
    ? undefined
    : params.workspacePath === undefined
      ? agentSessionPinnedLaunchDirectory(record)
      : params.workspacePath
  if (cwd && record.location.executionHostId === 'local' && record.location.wslDistro === null) {
    for (const bound of bindings.values()) {
      if (
        bound.params.agent === params.agent &&
        !!bound.params.legacy === !!params.legacy &&
        (bound.cwd ?? bound.folder ?? bound.workspacePath) === cwd &&
        (!bound.params.sessionId ||
          deps.getConversation(bound.params.sessionId)?.location.executionHostId === 'local') &&
        bound.base === agentModelCatalogFingerprintForRecord(record, bound.folder) &&
        bound.current() &&
        bound.identity === capture(bound.params)
      ) {
        return bound
      }
    }
  }
  if (
    deps.listsInChatFolder?.has(params.agent) ||
    params.workspace ||
    (params.workspacePath !== null &&
      (independentAgentModelCatalog(params.agent) ||
        (deps.agentReadsProjectModelConfig?.(params.agent) === true && !params.legacy)))
  ) {
    return
  }
  const fingerprint = agentModelCatalogFingerprintForRecord(record)
  return {
    identity: capture(params),
    params,
    current: () => true,
    cancel: () => {},
    fingerprint,
    base: fingerprint,
    exact: false,
    keepDefault:
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
          (!deps.store.verified(display) || (!bound.exact && !params.legacy))
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
    ...(result && (bound.folder !== undefined || bound.exact)
      ? { modelsDifferByWorkspace: true as const }
      : {}),
    ...(!params.savedOnly &&
    !params.verifiedOnly &&
    (deps.store.isListing(bound.fingerprint) ||
      (resolving && deps.store.probeDue(bound.fingerprint))) &&
    (independent || !listed)
      ? { listingInProgress: true as const }
      : {}),
    ...(deps.store.failure(bound.fingerprint)?.unavailable
      ? { unavailable: deps.store.failure(bound.fingerprint)?.unavailable }
      : {})
  }
}

export function retireAgentModelCatalogRequests(
  deps: AgentModelCatalogServiceDeps,
  bindings: Map<string, AgentModelCatalogBinding>,
  claims: Map<
    string,
    {
      identity: string
      params: AgentModelCatalogReadParams
      controller: AbortController
      current?: () => boolean
    }
  >,
  workspaceId?: string
): void {
  for (const [key, claim] of claims) {
    if (
      !(
        claim.current?.() ?? claim.identity === agentModelCatalogScopeIdentity(deps, claim.params)
      ) ||
      (workspaceId !== undefined &&
        claim.params.sessionId !== undefined &&
        deps.getConversation(claim.params.sessionId)?.location.workspaceId === workspaceId)
    ) {
      claim.controller.abort()
      claims.delete(key)
    }
  }
  for (const [key, bound] of bindings) {
    if (
      !bound.current() ||
      bound.identity !== agentModelCatalogScopeIdentity(deps, bound.params) ||
      (workspaceId !== undefined && bound.workspaceId === workspaceId)
    ) {
      bound.cancel()
      bindings.delete(key)
    }
  }
}

/** The invocation-qualified binding may differ from a live listing's account key. */
export function expireAgentModelCatalogBoundFailure(
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

export function agentModelCatalogSessionPeek(
  deps: AgentModelCatalogServiceDeps,
  binding: (params: AgentModelCatalogReadParams) => AgentModelCatalogBinding | undefined
) {
  return (sessionId: string, verifiedOnly?: boolean) => {
    const record = deps.getConversation(sessionId)
    const bound =
      record &&
      binding({
        agent: record.provider,
        sessionId,
        inSessionWorkspace: true,
        records: { record, scoped: onLiveAccount(deps, record), savedOnly: false }
      })
    const entry = bound ? deps.store.observation(bound.fingerprint) : null
    return entry && (!verifiedOnly || deps.store.verified(entry)) ? entry : null
  }
}
