const WORKSPACE_CHANGES = [
  'ready',
  'worktreesChanged',
  'reposChanged',
  'worktreeRowsChanged'
] as const

/** The workspace change a server's client event announces; catalog is false when only rows moved. */
export function workspaceChangeOfClientEvent(message: unknown): { catalog: boolean } | null {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return null
  }
  const change = WORKSPACE_CHANGES.find((type) => type === message.type)
  return change ? { catalog: change === 'ready' || change === 'reposChanged' } : null
}
