type HostEditRouter = {
  push: (href: `/h/${string}`) => void
  replace: (href: ReturnType<typeof mobileHostEditRoute>) => void
}

export const HOST_ROUTE_EDIT_ACTION = 'edit'

export function mobileHostEditRoute(hostId: string) {
  return {
    pathname: '/h/[hostId]/edit' as const,
    params: { hostId }
  }
}

export function hostRouteEditRedirect(
  routeAction: string | undefined,
  hostId: string | undefined
): ReturnType<typeof mobileHostEditRoute> | null {
  if (routeAction !== HOST_ROUTE_EDIT_ACTION || !hostId) {
    return null
  }
  return mobileHostEditRoute(hostId)
}

export function navigateToMobileHostEdit(router: HostEditRouter, hostId: string): void {
  // Why: a cold nested host navigator resolves a deep push to its index route,
  // and a frame-timed replace could fire before that stack committed — the
  // replace was then swallowed and the user stranded on the index screen.
  // Land on the index route with an explicit action param instead and let the
  // mounted screen redirect itself to the edit form (see HostScreen).
  router.push(`/h/${hostId}?action=${HOST_ROUTE_EDIT_ACTION}`)
}
