const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_PARAM = 'supportsWorktreeVisibilitySourceDefaults'

export function projectMobileRpcRequestParams(method: string, params: unknown): unknown {
  if (method !== 'worktree.ps') {
    return params
  }
  const current =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {}
  return { ...current, [WORKTREE_VISIBILITY_SOURCE_DEFAULTS_PARAM]: true }
}
