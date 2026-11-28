/** What a server's client event means to a desktop relaying it: a workspace change, an agent-row change, or nothing. */
export function serverClientEventChange(
  message: unknown
): 'ready' | 'worktreesChanged' | 'reposChanged' | 'agentRows' | null {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return null
  }
  const { type } = message
  if (type === 'worktreeRowsChanged' || type === 'agentListChanged') {
    return 'agentRows'
  }
  return type === 'ready' || type === 'worktreesChanged' || type === 'reposChanged' ? type : null
}
