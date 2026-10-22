/**
 * Home's New Workspace: a transparent overlay over Home that asks which desktop (when more than one
 * is offered) and then shows that desktop's Create Workspace drawer.
 */
export function newWorkspaceOverlayHref(hostIds: readonly string[]) {
  return { pathname: '/new-workspace', params: { hostIds: hostIds.join(',') } } as const
}

/** The offered desktops, in Home's order, from the overlay route's `hostIds` param. */
export function readOfferedHostIds(param: string): string[] {
  return param.split(',').filter((hostId) => hostId !== '')
}
