export function newWorkspaceOverlayHref(hostIds: readonly string[]) {
  return { pathname: '/new-workspace', params: { hostIds: hostIds.join(',') } } as const
}

export function readOfferedHostIds(param: string): string[] {
  return param.split(',').filter((hostId) => hostId !== '')
}
