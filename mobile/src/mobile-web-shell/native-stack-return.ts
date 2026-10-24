import { stringifyRouteHref } from '../navigation/route-href'

export type NativeStackState = Readonly<{
  key?: string
  index?: number
  routes: readonly NativeStackRoute[]
}>

type NativeStackRoute = Readonly<{
  key?: string
  name: string
  params?: object
  state?: NativeStackState
}>

/** A pop of `count` screens off the navigator keyed `target`, counted from its route `source`.
 *  `source` is explicit because a screen's `dispatch` stamps its own key there otherwise, and a parent
 *  navigator that cannot find that key among its routes drops the pop. */
export type NativeStackReturn = Readonly<{ target: string; source: string; count: number }>

/** Expo-router file segments that name no part of the URL: `index`, `(group)` and its own `__root`. */
function isUrlSegment(segment: string): boolean {
  return segment !== 'index' && !/^\(.*\)$/.test(segment) && !segment.startsWith('__')
}

/** A state not yet rehydrated may omit `index`; React Navigation reads that as its last route. */
function focusedIndex(state: NativeStackState): number {
  return state.index ?? state.routes.length - 1
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** One spelling per URL: decoded path segments and the query sorted, as expo-router parses both.
 *  An empty value is dropped because screens clear a param with `''` (session `paneKey`), and the
 *  fragment because expo-router keeps it as a param no href spells the same way. */
function canonicalHref(href: string): string {
  const [path = '', search = ''] = href.split('#')[0].split('?')
  const segments = path.split('/').filter(Boolean).map(decodeSegment)
  const query = [...new URLSearchParams(search)]
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `/${segments.join('/')}?${new URLSearchParams(query).toString()}`
}

/** The URL a route on the stack shows, or null when its params hold something no URL carries. */
function routeHref(route: NativeStackRoute, parentNames: readonly string[]): string | null {
  const names = [...parentNames, route.name]
  const nested = route.state?.routes[focusedIndex(route.state)]
  if (nested) {
    return routeHref(nested, names)
  }
  const params: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(route.params ?? {})) {
    if (typeof value === 'string') {
      params[key] = value
    } else if (Array.isArray(value) && value.every((one) => typeof one === 'string')) {
      params[key] = value
    } else if (value !== undefined) {
      return null
    }
  }
  const pathname = `/${names
    .flatMap((name) => name.split('/'))
    .filter(isUrlSegment)
    .join('/')}`
  return canonicalHref(stringifyRouteHref({ pathname, params }))
}

function returnWithin(
  level: NativeStackState,
  parentNames: readonly string[],
  wanted: string
): NativeStackReturn | 'current' | null {
  const current = focusedIndex(level)
  const focused = level.routes[current]
  if (!focused) {
    return null
  }
  if (focused.state) {
    // The deeper navigator first: its screens sit nearer the top than anything at this level.
    const deeper = returnWithin(focused.state, [...parentNames, focused.name], wanted)
    if (deeper) {
      return deeper
    }
  } else if (routeHref(focused, parentNames) === wanted) {
    return 'current'
  }
  if (!level.key || !focused.key) {
    return null
  }
  for (let index = current - 1; index >= 0; index--) {
    if (routeHref(level.routes[index], parentNames) === wanted) {
      return { target: level.key, source: focused.key, count: current - index }
    }
  }
  return null
}

/**
 * Where `href` already sits on the native stack: `'current'` when it is the focused screen, the pop
 * that returns to the nearest screen below showing it, or null when it is nowhere on the stack.
 *
 * Path and query both count, so another worktree or tab under the same file is a different screen.
 */
export function nativeStackReturn(
  state: NativeStackState,
  href: string
): NativeStackReturn | 'current' | null {
  return returnWithin(state, [], canonicalHref(href))
}
