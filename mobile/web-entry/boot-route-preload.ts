import { createElement, lazy, useState, type ComponentType } from 'react'
import { matchesRoutePattern } from '../src/mobile-web-shell/page-route-policy'

type RouteComponent = ComponentType<Record<string, unknown>>
type RouteModule = { default: RouteComponent }
type Preload = () => Promise<unknown>

const layouts: Preload[] = []
const screens: { pattern: string; preload: Preload }[] = []

// A route loaded before its first render mounts without suspending; a boot fallback holds the screen back 300 ms.
export function bootRoute(
  load: () => Promise<RouteModule>,
  /** 'layout', the screen's route pattern, or null for an entry the page never preloads. */
  scope: string | null
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
  if (scope === 'layout') {
    layouts.push(preload)
  } else if (scope !== null) {
    screens.push({ pattern: scope, preload })
  }
  return { default: BootRoute }
}

// Every page route sits under every page layout, so all layouts load. Failed preloads boot through the lazy path.
export async function preloadBootRoutes(pathname: string): Promise<void> {
  const matching = screens.filter(({ pattern }) => matchesRoutePattern(pathname, pattern))
  // Expo Router prefers a fixed route over a catch-all one.
  const fixed = matching.filter(
    ({ pattern }) => !pattern.split('/').some((segment) => segment.startsWith('[...'))
  )
  await Promise.allSettled([
    ...layouts.map((preload) => preload()),
    ...(fixed.length > 0 ? fixed : matching).map(({ preload }) => preload())
  ])
}
