import { createContext, useContext } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RouterHref } from './route-href'

// Keep context separate from WorkspaceRoute so readers need not import Expo.
export const WorkspaceExecutionHostContext = createContext<ExecutionHostId | undefined>(undefined)

export function useWorkspaceExecutionHost(): ExecutionHostId | undefined {
  return useContext(WorkspaceExecutionHostContext)
}

// Gate editor-tab-only actions by route execution host; direct headless pairings still count as the paired desktop, matching main.
export function useWorkspaceOnPairedHost(): boolean {
  // No host advertises window availability; routed workspace calls already target their execution host.
  return useWorkspaceExecutionHost() === undefined
}

// Carry executionHost on pushed workspace params so navigation stays on the same server.
export function workspaceRouteParams(executionHost: ExecutionHostId | undefined): {
  executionHost?: ExecutionHostId
} {
  return executionHost ? { executionHost } : {}
}

export function workspaceRouteHref(
  href: string,
  executionHost: ExecutionHostId | undefined
): string {
  if (!executionHost) {
    return href
  }
  return `${href}${href.includes('?') ? '&' : '?'}executionHost=${encodeURIComponent(executionHost)}`
}

export function workspaceHref(href: RouterHref, executionHost: ExecutionHostId): RouterHref {
  return typeof href === 'string'
    ? workspaceRouteHref(href, executionHost)
    : { ...href, params: { ...href.params, executionHost } }
}
