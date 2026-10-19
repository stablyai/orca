import {
  parseExecutionHostId,
  type ExecutionHostId,
  type ParsedExecutionHost
} from '../shared/execution-host'
import type { RuntimeListingHostScope } from '../shared/runtime-listing-host-scope'
import { findEnvironmentByName } from './host-selector-alternatives'

export type OmittedHostScopeSelector = {
  hostId: ExecutionHostId
  /** The flag that routes a follow-up query to this host, or null when it names nothing here. */
  selector: string | null
}

/** A host scope annotated on this machine. The runtime never sends `omittedHostSelectors`. */
export type ListingHostScopeWithSelectors = RuntimeListingHostScope & {
  omittedHostSelectors?: OmittedHostScopeSelector[]
}

export type WithAnnotatedHostScope<TResult> = Omit<TResult, 'hostScope'> & {
  hostScope?: ListingHostScopeWithSelectors
}

/**
 * Resolves how to reach each host a listing did not cover.
 *
 * `hostScope` is the documented way to complete a partial listing, but `omittedHostIds` is built
 * from the runtime's own bookkeeping — repos, folder workspaces, and workspace sessions — so it
 * names `runtime:` ids for servers that are no longer paired. An agent looping over the list to
 * finish the job hard-errors on those.
 *
 * The ids are kept rather than filtered: dropping one would shrink what the listing admits it did
 * not cover, and `docs/reference/ssh-execution-boundary.md` requires a listing to name its gaps.
 * A `null` selector marks the ones this machine cannot name, which is the part a caller needs.
 * Only the local pairing store is consulted, so this answers "can I select it", never "is it up" —
 * no host is claimed live or exited on this path.
 *
 * `local` and `ssh:` hosts get no selector: the listing commands take no `--host` (#29901), and
 * the runtime that answered is the one that reaches them, so no flag would route elsewhere.
 */
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
  return null
}

/** Renders a scope line; an absent scope means the host never reported one, not full coverage. */
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

/** Attaches the resolved selectors in place; a listing with no omitted hosts pays nothing. */
export async function annotateOmittedHostScope(result: {
  hostScope?: ListingHostScopeWithSelectors
}): Promise<void> {
  const scope = result.hostScope
  if (!scope || scope.omittedHostIds.length === 0) {
    return
  }
  scope.omittedHostSelectors = await resolveOmittedHostScopeSelectors(scope.omittedHostIds)
}
