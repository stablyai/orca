type HostEditRouter = {
  push: (href: `/h/${string}`) => void
  replace: (href: ReturnType<typeof mobileHostEditRoute>) => void
}

export function mobileHostEditRoute(hostId: string) {
  return {
    pathname: '/h/[hostId]/edit' as const,
    params: { hostId }
  }
}

export function navigateToMobileHostEdit(router: HostEditRouter, hostId: string): void {
  // Why: a cold nested host navigator resolves a deep push to its index route.
  router.push(`/h/${hostId}`)
  requestAnimationFrame(() => {
    router.replace(mobileHostEditRoute(hostId))
  })
}
