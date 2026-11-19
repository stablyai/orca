/** Profile-state domains that hold saved workspace sessions (local and per host). */
export const WORKSPACE_SESSION_DOMAINS = ['workspaceSession', 'workspaceSessionsByHostId'] as const

const SESSION_DOMAINS: ReadonlySet<string> = new Set(WORKSPACE_SESSION_DOMAINS)

export function isWorkspaceSessionDomain(domain: string): boolean {
  return SESSION_DOMAINS.has(domain)
}
