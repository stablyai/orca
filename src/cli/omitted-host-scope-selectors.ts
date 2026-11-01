import {
  parseExecutionHostId,
  type ExecutionHostId,
  type ParsedExecutionHost
} from '../shared/execution-host'
import type { RuntimeListingHostScope } from '../shared/runtime-listing-host-scope'
import { findEnvironmentByName } from './host-selector-alternatives'

export type OmittedHostScopeSelector = {
  hostId: ExecutionHostId
  /** null means this machine has no selector for the omitted host. */
  selector: string | null
}

/** omittedHostSelectors is added locally, never sent by the runtime. */
export type ListingHostScopeWithSelectors = RuntimeListingHostScope & {
  omittedHostSelectors?: OmittedHostScopeSelector[]
}

export type WithAnnotatedHostScope<TResult> = Omit<TResult, 'hostScope'> & {
  hostScope?: ListingHostScopeWithSelectors
}

// Preserve unreachable hosts as coverage gaps; pairing proves selectability, not liveness.
export async function resolveOmittedHostScopeSelectors(
  omittedHostIds: readonly ExecutionHostId[]
): Promise<OmittedHostScopeSelector[]> {
  const parsed = omittedHostIds.map((hostId) => ({
    hostId,
    host: parseExecutionHostId(hostId)
  }))
  const environments = parsed.some((entry) => entry.host?.kind === 'runtime')
    ? await listPairedEnvironments()
    : []
  return parsed.map(({ hostId, host }) => ({
    hostId,
    selector: resolveSelector(host, environments)
  }))
}

async function listPairedEnvironments(): Promise<{ id: string; name: string }[]> {
  const [{ listEnvironments }, { getDefaultUserDataPath }] = await Promise.all([
    import('./runtime/environments.js'),
    import('./runtime-client.js')
  ])
  return listEnvironments(getDefaultUserDataPath()).map((environment) => ({
    id: environment.id,
    name: environment.name
  }))
}

function resolveSelector(
  host: ParsedExecutionHost | null,
  environments: readonly { id: string; name: string }[]
): string | null {
  if (host?.kind === 'runtime') {
    const environment = findEnvironmentByName(environments, host.environmentId)
    return environment ? `--environment ${environment.name}` : null
  }
  // Listings take no --host flag; local and SSH hosts are reached through the answering runtime.
  return null
}

/** An absent scope means coverage is unknown. */
export function formatListingHostScope(scope: ListingHostScopeWithSelectors | undefined): string {
  if (!scope) {
    return 'scope: unverifiable — this host does not report which hosts it lists'
  }
  const covered = scope.hostIds.length > 0 ? scope.hostIds.join(', ') : 'none'
  if (scope.omittedHostIds.length === 0) {
    return `scope: ${covered}`
  }
  const selectorByHostId = new Map(
    (scope.omittedHostSelectors ?? []).map((entry) => [entry.hostId, entry.selector])
  )
  const omitted = scope.omittedHostIds.map((hostId) => {
    if (!selectorByHostId.has(hostId)) {
      return hostId
    }
    const selector = selectorByHostId.get(hostId)
    if (selector) {
      return `${hostId} (${selector})`
    }
    const kind = parseExecutionHostId(hostId)?.kind
    return kind === 'local' || kind === 'ssh'
      ? `${hostId} (reached through this runtime; no flag selects it)`
      : `${hostId} (not selectable from this machine)`
  })
  return `scope: ${covered} — not covered: ${omitted.join(', ')}`
}

export async function annotateOmittedHostScope(result: {
  hostScope?: ListingHostScopeWithSelectors
}): Promise<void> {
  const scope = result.hostScope
  if (!scope || scope.omittedHostIds.length === 0) {
    return
  }
  scope.omittedHostSelectors = await resolveOmittedHostScopeSelectors(scope.omittedHostIds)
}
