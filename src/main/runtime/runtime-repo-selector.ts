import type { ExecutionHostId } from '../../shared/execution-host'

/** Carry optional host through every re-resolution: one repo id can be registered on several hosts. */
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
