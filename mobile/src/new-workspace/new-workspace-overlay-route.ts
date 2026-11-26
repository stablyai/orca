export function newWorkspaceOverlayHref(
  hostIds: readonly string[],
  creationKind: 'worktree' | 'chat' = 'worktree'
) {
  return {
    pathname: '/new-workspace',
    params: { hostIds: hostIds.join(','), creationKind }
  } as const
}

export function readOfferedHostIds(param: string): string[] {
  return param.split(',').filter((hostId) => hostId !== '')
}
