import type { ExecutionHostId } from '../../shared/execution-host'

/**
 * A repo selector, optionally narrowed to one host. One repo id can be set up on several hosts, so
 * the host travels with the selector: every lookup that re-resolves it keeps the caller's choice.
 */
export type RuntimeRepoSelector =
  | string
  | { readonly selector: string; readonly hostId: ExecutionHostId }

/** The wire pair (`repo`, optional `repoHostId`) as one selector; absent host keeps the old string. */
export function hostQualifiedRepoSelector(
  selector: string,
  hostId: ExecutionHostId | undefined
): RuntimeRepoSelector {
  return hostId ? { selector, hostId } : selector
}

export function runtimeRepoSelectorText(selector: RuntimeRepoSelector): string {
  return typeof selector === 'string' ? selector : selector.selector
}

export function runtimeRepoSelectorHostId(
  selector: RuntimeRepoSelector
): ExecutionHostId | undefined {
  return typeof selector === 'string' ? undefined : selector.hostId
}
