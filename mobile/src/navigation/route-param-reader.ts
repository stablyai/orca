import {
  canonicalExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'

// Use the first repeated Expo query value; array coercion would encode a,b as one valid but nonexistent host segment. Keep this free of screen/git-status imports.
export function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function readWorkspaceRouteExecutionHost(
  value: string | string[] | undefined
): ExecutionHostId | undefined {
  // Expo can decode the host segment inside the route param before we match the desktop catalog.
  return canonicalExecutionHostId(firstParam(value)) ?? undefined
}
