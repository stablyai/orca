const WORKSPACE_CHANGES = [
  'ready',
  'worktreesChanged',
  'reposChanged',
  'worktreeRowsChanged'
] as const

/**
 * The workspace change a server's client event announces: catalog is false when only rows moved,
 * live marks the stream (re)opening, after which any event since the last read may have been missed.
 */
export function workspaceChangeOfClientEvent(
  message: unknown
): { catalog: boolean; live?: true } | null {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return null
  }
  const change = WORKSPACE_CHANGES.find((type) => type === message.type)
  if (change === 'ready') {
    return { catalog: true, live: true }
  }
  return change ? { catalog: change === 'reposChanged' } : null
}
