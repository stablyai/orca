import { createContext, useContext } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RouterHref } from './route-href'

// Provided by `WorkspaceRoute`; apart from it so readers need not load expo-router.
export const WorkspaceExecutionHostContext = createContext<ExecutionHostId | undefined>(undefined)

export function useWorkspaceExecutionHost(): ExecutionHostId | undefined {
  return useContext(WorkspaceExecutionHostContext)
}

/**
 * Whether this workspace runs on the paired desktop itself. Gates actions whose only result is an
 * editor tab; for everything else the host's reply decides where it goes.
 * A phone paired directly with a headless host still reads true, matching main's behaviour there.
 */
export function useWorkspaceOnPairedHost(): boolean {
  // Why the route, not a host signal: no host advertises a desktop window, and a server workspace's calls go to its own host.
  return useWorkspaceExecutionHost() === undefined
}

/** The params a push into another screen of this workspace carries, so it stays on the server. */
export function workspaceRouteParams(executionHost: ExecutionHostId | undefined): {
  executionHost?: ExecutionHostId
} {
  return executionHost ? { executionHost } : {}
}

/** The same, for a pushed href string. */
export function workspaceRouteHref(
  href: string,
  executionHost: ExecutionHostId | undefined
): string {
  if (!executionHost) {
    return href
  }
  return `${href}${href.includes('?') ? '&' : '?'}executionHost=${encodeURIComponent(executionHost)}`
}

/** The same, for any router target. */
export function workspaceHref(href: RouterHref, executionHost: ExecutionHostId): RouterHref {
  return typeof href === 'string'
    ? workspaceRouteHref(href, executionHost)
    : { ...href, params: { ...href.params, executionHost } }
}
