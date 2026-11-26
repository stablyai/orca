/** A workspace a page shows; `executionHost` is the route's server, absent for the desktop's own. */
export type ViewedWorkspace = { worktreeId: string; executionHost?: string }

// The session a page location names, or null for any other screen.
export function sessionOfPageLocation(href: string): ViewedWorkspace | null {
  const match = /^\/h\/[^/?]+\/session\/([^/?]+)(?:\?(.*))?$/.exec(href)
  if (match === null) {
    return null
  }
  try {
    const executionHost = new URLSearchParams(match[2] ?? '').get('executionHost')
    return {
      worktreeId: decodeURIComponent(match[1]!),
      ...(executionHost ? { executionHost } : {})
    }
  } catch {
    return null
  }
}
