export type MobileSessionRouteParams = {
  hostId: string
  worktreeId: string
  name?: string
}

export type MobileSessionHref = {
  pathname: '/h/[hostId]/session/[worktreeId]'
  params: MobileSessionRouteParams
}

export function createMobileSessionHref(params: MobileSessionRouteParams): MobileSessionHref {
  return {
    pathname: '/h/[hostId]/session/[worktreeId]',
    params
  }
}
