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

// Set source explicitly: screen dispatch otherwise stamps its own key, which a parent navigator cannot find and silently drops.
export type NativeStackReturn = Readonly<{ target: string; source: string; count: number }>

function isUrlSegment(segment: string): boolean {
  return segment !== 'index' && !/^\(.*\)$/.test(segment) && !segment.startsWith('__')
}

// Before rehydration, React Navigation treats absent index as the last route.
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

// Decode paths and sort query for Expo URL equality; omit fragments and empty params because screens use empty strings to clear requests.
function canonicalHref(href: string): string {
  const [path = '', search = ''] = href.split('#')[0].split('?')
  const segments = path.split('/').filter(Boolean).map(decodeSegment)
  const query = [...new URLSearchParams(search)]
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `/${segments.join('/')}?${new URLSearchParams(query).toString()}`
}

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
    // Search deeper navigators first because their entries are nearer the stack top.
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

// Compare path and query so different worktrees/tabs are distinct; return the nearest matching entry, current, or no match.
export function nativeStackReturn(
  state: NativeStackState,
  href: string
): NativeStackReturn | 'current' | null {
  return returnWithin(state, [], canonicalHref(href))
}
