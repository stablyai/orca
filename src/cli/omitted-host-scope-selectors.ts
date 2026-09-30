import {
  parseExecutionHostId,
  type ExecutionHostId,
  type ParsedExecutionHost
} from '../shared/execution-host'
import type { RuntimeListingHostScope } from '../shared/runtime-listing-host-scope'
import {
  findEnvironmentByName,
  findSshTargetByName,
  listSshTargets,
  type SshTargetSummary
} from './host-selector-alternatives'
import type { RuntimeClient } from './runtime-client'

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
 * Only the local pairing store and SSH-target registry are consulted, so this answers "can I
 * select it", never "is it up" — no host is claimed live or exited on this path.
 */
export async function resolveOmittedHostScopeSelectors(
  client: RuntimeClient,
  omittedHostIds: readonly ExecutionHostId[]
): Promise<OmittedHostScopeSelector[]> {
  const parsed = omittedHostIds.map((hostId) => ({
    hostId,
    host: parseExecutionHostId(hostId)
  }))
  const environments = parsed.some((entry) => entry.host?.kind === 'runtime')
    ? await listPairedEnvironments()
    : []
  // Why: SSH targets need a round trip, so only pay for it when an ssh host was actually omitted.
  const sshTargets = parsed.some((entry) => entry.host?.kind === 'ssh')
    ? await listSshTargets(client)
    : []
  return parsed.map(({ hostId, host }) => ({
    hostId,
    selector: resolveSelector(host, environments, sshTargets)
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
  environments: readonly { id: string; name: string }[],
  sshTargets: readonly SshTargetSummary[]
): string | null {
  if (host?.kind === 'local') {
    return '--host local'
  }
  if (host?.kind === 'ssh') {
    return findSshTargetByName(sshTargets, host.targetId) ? `--host ssh:${host.targetId}` : null
  }
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
    return selector ? `${hostId} (${selector})` : `${hostId} (not selectable from this machine)`
  })
  return `scope: ${covered} — not covered: ${omitted.join(', ')}`
}

/** Attaches the resolved selectors in place; a listing with no omitted hosts pays nothing. */
export async function annotateOmittedHostScope(
  client: RuntimeClient,
  result: { hostScope?: ListingHostScopeWithSelectors }
): Promise<void> {
  const scope = result.hostScope
  if (!scope || scope.omittedHostIds.length === 0) {
    return
  }
  scope.omittedHostSelectors = await resolveOmittedHostScopeSelectors(client, scope.omittedHostIds)
}
