const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_PARAM = 'supportsWorktreeVisibilitySourceDefaults'
const WORKTREE_RESTORED_AGENT_PRESENCE_PARAM = 'supportsWorktreeRestoredAgentPresence'

export function projectMobileRpcRequestParams(method: string, params: unknown): unknown {
  if (method !== 'worktree.ps') {
    return params
  }
  const current =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {}
  return {
    ...current,
    [WORKTREE_VISIBILITY_SOURCE_DEFAULTS_PARAM]: true,
    [WORKTREE_RESTORED_AGENT_PRESENCE_PARAM]: true
  }
}
