import { createElement, lazy, useState, type ComponentType } from 'react'
import { matchesRoutePattern } from '../src/mobile-web-shell/page-route-policy'

type RouteComponent = ComponentType<Record<string, unknown>>
type RouteModule = { default: RouteComponent }
/** A layout covers every pathname under its directory; a screen matches its own pattern. */
export type BootRouteScope = { layout: string } | { screen: string }

const bootRoutes: { scope: BootRouteScope; preload: () => Promise<unknown> }[] = []

// A route preloaded before the first render mounts without suspending. A boot fallback would make React
// hold the finished screen until 300 ms after that fallback showed (its Suspense reveal throttle).
export function bootRoute(
  load: () => Promise<RouteModule>,
  scope: BootRouteScope | null
): RouteModule {
  let loaded: RouteComponent | null = null
  let pending: Promise<RouteModule> | null = null
  const preload = (): Promise<RouteModule> =>
    (pending ??= load().then(
      (module) => {
        loaded = module.default
        return module
      },
      (error: unknown) => {
        // Let the lazy path import again rather than replay this failure.
        pending = null
        throw error
      }
    ))
  const Lazy = lazy(preload)
  function BootRoute(props: Record<string, unknown>) {
    // Keep the first pick: swapping the lazy for the loaded component would remount the route.
    const [Route] = useState<RouteComponent>(() => loaded ?? Lazy)
    return createElement(Route, props)
  }
  if (scope !== null) {
    bootRoutes.push({ scope, preload })
  }
  return { default: BootRoute }
}

function withinLayout(pathname: string, directory: string): boolean {
  const depth = directory.split('/').length
  return matchesRoutePattern(pathname.split('/').slice(0, depth).join('/'), directory)
}

// Settles once the pathname's layouts and screen have loaded or failed; failed ones boot through the lazy path.
export async function preloadBootRoutes(pathname: string): Promise<void> {
  const screens = bootRoutes.filter(
    ({ scope }) => 'screen' in scope && matchesRoutePattern(pathname, scope.screen)
  )
  // Expo Router prefers a fixed route over a catch-all one.
  const fixed = screens.filter(({ scope }) => 'screen' in scope && !scope.screen.includes('[...'))
  const layouts = bootRoutes.filter(
    ({ scope }) => 'layout' in scope && withinLayout(pathname, scope.layout)
  )
  await Promise.allSettled(
    [...layouts, ...(fixed.length > 0 ? fixed : screens)].map(({ preload }) => preload())
  )
}
