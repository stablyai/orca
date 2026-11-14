import type { StructuredAgentResolutionOperation } from '../agent-launch/structured-agent-command-resolution'
import { resolveHiddenProbeCwd } from '../../lib/hidden-probe-cwd'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type {
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import { agentModelCatalogScopeFingerprint } from './agent-model-catalog-fingerprint'
import { independentAgentModelCatalog } from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import type {
  AgentModelCatalogLookup,
  AgentModelCatalogResolvedProbe
} from './agent-model-catalog-discovery'
import { sessionWorkspacePath, type AgentModelCatalogRecord } from './agent-model-catalog-workspace'

/** Discovery follows launch configuration, never session picks. */
export async function resolveAgentModelCatalogScope(
  deps: AgentModelCatalogServiceDeps,
  params: Parameters<AgentModelCatalogService['read']>[0],
  record: AgentModelCatalogRecord | undefined,
  base: string,
  home: AgentSessionAccountHome | null,
  current: () => boolean = () => true,
  operation?: StructuredAgentResolutionOperation
): Promise<{
  base: string
  fingerprint: string
  exact: boolean
  accountListing?: boolean
  cwd?: string
  resolved?: AgentModelCatalogResolvedProbe
} | null> {
  if (!current()) {
    return null
  }
  if (!home) {
    return { base, fingerprint: base, exact: false }
  }
  if (record && !isNativeLocalLocation(record.location)) {
    return { base, fingerprint: base, exact: false }
  }
  const probe = deps.probes?.[params.agent]
  // Fixed when its readers asked: no chat closing later turns a shared refresh passive.
  const savedOnly = () => !!params.savedOnly
  if (params.legacy && independentAgentModelCatalog(params.agent)) {
    const fingerprint = agentModelCatalogScopeFingerprint(base, 'legacy-account')
    let resolved = await probe
      ?.resolveLegacy?.(home, operation, savedOnly() ? 'saved' : 'snapshot')
      .catch(() => null)
    if (!current()) {
      return null
    }
    if (resolved?.inputStamp !== undefined) {
      deps.store.observeInputs(fingerprint, resolved.inputStamp)
    }
    if (!savedOnly() && deps.store.probeDue(fingerprint)) {
      resolved = await probe?.resolveLegacy?.(home, operation, 'recover').catch(() => null)
    }
    if (!current()) {
      return null
    }
    if (resolved?.inputStamp !== undefined) {
      deps.store.observeInputs(fingerprint, resolved.inputStamp)
    }
    return {
      base,
      fingerprint,
      exact: false,
      ...(resolved ? { resolved } : {})
    }
  }
  if (!independentAgentModelCatalog(params.agent)) {
    const cwd =
      params.workspacePath ?? (record ? await sessionWorkspacePath(deps, record) : undefined)
    let resolved = await probe
      ?.resolve?.(home, cwd ?? '', savedOnly() ? 'saved' : 'snapshot', operation)
      .catch(() => null)
    if (!current()) {
      return null
    }
    if (resolved?.inputStamp !== undefined) {
      deps.store.observeInputs(base, resolved.inputStamp)
    }
    if (!savedOnly() && deps.store.probeDue(base)) {
      resolved = await probe?.resolve?.(home, cwd ?? '', 'recover', operation).catch(() => null)
    }
    if (!current()) {
      return null
    }
    if (resolved?.inputStamp !== undefined) {
      deps.store.observeInputs(base, resolved.inputStamp)
    }
    return { base, fingerprint: base, exact: false, ...(resolved ? { resolved } : {}) }
  }
  // The list belongs to the account and the CLI a chat here would launch, not to this folder:
  // resolve the executable where the chat runs, but list from an empty Orca-owned folder so the
  // listing reads only account settings (a home folder can hold another account's settings as
  // project settings) and every workspace sharing that invocation shares one listing. A command
  // line that may name files in the chat's folder lists there instead (`catalogListingDirectory`).
  let listIn: string
  try {
    listIn = resolveHiddenProbeCwd()
  } catch {
    return { base, fingerprint: base, exact: false }
  }
  // A workspace this host can't inspect lists as the account does (its default stays unknown),
  // never from wherever Orca itself runs.
  const cwd =
    params.workspacePath === null
      ? listIn
      : (params.workspacePath ?? (record ? await sessionWorkspacePath(deps, record) : listIn))
  if (!current()) {
    return null
  }
  if (!cwd) {
    return { base, fingerprint: base, exact: false, cwd: listIn }
  }
  const resolve = (lookup: AgentModelCatalogLookup) =>
    probe?.resolve?.(home, listIn, lookup, operation, cwd).catch(() => null)
  const scopeKey = (resolved: AgentModelCatalogResolvedProbe | null | undefined) =>
    agentModelCatalogScopeFingerprint(base, listIn, resolved?.identity)
  let resolved = await resolve(savedOnly() ? 'saved' : 'snapshot')
  if (!current()) {
    return null
  }
  if (resolved?.inputStamp !== undefined) {
    deps.store.observeInputs(scopeKey(resolved), resolved.inputStamp)
  }
  // Rerun shells only for reads due to list; saved-only reads must remain passive.
  if (!savedOnly() && (!resolved || deps.store.probeDue(scopeKey(resolved)))) {
    resolved = await resolve('recover')
  }
  if (!current() || (probe?.resolve && !resolved)) {
    return null
  }
  if (resolved?.inputStamp !== undefined) {
    deps.store.observeInputs(scopeKey(resolved), resolved.inputStamp)
  }
  return {
    base,
    fingerprint: scopeKey(resolved),
    exact: true,
    // The account's own listing (prewarm names no folder or chat) seeds what unlisted folders show.
    accountListing: !record && params.workspacePath === undefined && !params.legacy,
    cwd: listIn,
    ...(resolved ? { resolved } : {})
  }
}
