export type MobileHostEditNavigationState = Readonly<{
  index: number
  routes: readonly MobileHostEditNavigationRoute[]
}>

export type MobileHostEditNavigationRoute = Readonly<{
  name: string
  params?: Readonly<{ hostId?: unknown }>
}>

export type MobileHostEditRootNavigation = {
  addListener: (event: 'state', listener: () => void) => () => void
  getState: () => MobileHostEditNavigationState
}

export type MobileHostEditRouter = {
  push: (href: `/h/${string}`) => void
  replace: (href: ReturnType<typeof mobileHostEditRoute>) => void
}

export type MobileHostEditNavigationController = Readonly<{
  cancel: () => void
}>

export function mobileHostEditHostRoute(hostId: string): `/h/${string}` {
  return `/h/${encodeURIComponent(hostId)}`
}

export function mobileHostEditRoute(hostId: string) {
  return {
    pathname: '/h/[hostId]/edit' as const,
    params: { hostId }
  }
}

export function navigateToMobileHostEdit(
  navigation: MobileHostEditRootNavigation,
  router: MobileHostEditRouter,
  hostId: string
): MobileHostEditNavigationController {
  let active = true
  let hostRouteSeen = false
  let unsubscribeState = () => {}
  const dispose = () => {
    if (!active) {
      return
    }
    active = false
    unsubscribeState()
  }

  // Why: cold Expo deep links resolve to index; target Edit after the host route commits.
  const onState = () => {
    if (!active) {
      return
    }
    const state = navigation.getState()
    const currentRoute = state.routes[state.index]
    if (currentRoute?.name !== 'h') {
      if (hostRouteSeen) {
        dispose()
      }
      return
    }
    hostRouteSeen = true
    if (currentRoute.params?.hostId !== hostId) {
      return
    }
    dispose()
    router.replace(mobileHostEditRoute(hostId))
  }

  try {
    unsubscribeState = navigation.addListener('state', onState)
    router.push(mobileHostEditHostRoute(hostId))
  } catch (error) {
    dispose()
    throw error
  }
  return { cancel: dispose }
}
