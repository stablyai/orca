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
export function focusedIndex(state: NativeStackState): number {
  return state.index ?? state.routes.length - 1
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function hrefQuery(href: string): URLSearchParams {
  const path = href.split('#')[0]
  const cut = path.indexOf('?')
  return new URLSearchParams(cut === -1 ? '' : path.slice(cut + 1))
}

type HrefParts = Readonly<{ segments: readonly string[]; query: URLSearchParams }>

// Split on the encoded href's delimiters, then decode: a decoded id may hold '/' or '?' and must stay one segment.
function hrefParts(href: string): HrefParts {
  const path = href.split(/[?#]/, 1)[0]
  return { segments: path.split('/').filter(Boolean).map(decodeSegment), query: hrefQuery(href) }
}

// Sort query for Expo URL equality; omit empty params because screens use empty strings to clear requests.
function exactKey({ segments, query }: HrefParts): string {
  const params = [...query]
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([segments, params])
}

// A session is its path and executionHost; paneKey, name and standalone ride on the entry without naming another one.
function sessionKey({ segments, query }: HrefParts): string {
  return JSON.stringify([segments, query.get('executionHost') ?? ''])
}

function routeParts(route: NativeStackRoute, parentNames: readonly string[]): HrefParts | null {
  const names = [...parentNames, route.name]
  const nested = route.state?.routes[focusedIndex(route.state)]
  if (nested) {
    return routeParts(nested, names)
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
  return hrefParts(stringifyRouteHref({ pathname, params }))
}

type StackMatch = Readonly<{ target?: string; source?: string; routeKey?: string; count: number }>

function matchWithin(
  level: NativeStackState,
  parentNames: readonly string[],
  matches: (route: HrefParts | null) => boolean
): StackMatch | null {
  const current = focusedIndex(level)
  const focused = level.routes[current]
  if (!focused) {
    return null
  }
  if (focused.state) {
    // Search deeper navigators first because their entries are nearer the stack top.
    const deeper = matchWithin(focused.state, [...parentNames, focused.name], matches)
    if (deeper) {
      return deeper
    }
  } else if (matches(routeParts(focused, parentNames))) {
    return { target: level.key, source: focused.key, routeKey: focused.key, count: 0 }
  }
  if (!level.key || !focused.key) {
    return null
  }
  for (let index = current - 1; index >= 0; index--) {
    const route = level.routes[index]
    if (matches(routeParts(route, parentNames))) {
      return {
        target: level.key,
        source: focused.key,
        routeKey: route.key,
        count: current - index
      }
    }
  }
  return null
}

// Compare path and query so different worktrees/tabs are distinct; return the nearest matching entry, current, or no match.
export function nativeStackReturn(
  state: NativeStackState,
  href: string
): NativeStackReturn | 'current' | null {
  const wanted = exactKey(hrefParts(href))
  const match = matchWithin(
    state,
    [],
    (candidate) => candidate !== null && exactKey(candidate) === wanted
  )
  if (match === null) {
    return null
  }
  if (match.count === 0) {
    return 'current'
  }
  return match.target && match.source
    ? { target: match.target, source: match.source, count: match.count }
    : null
}

export type NativeSessionReturn = NativeStackReturn & Readonly<{ routeKey: string }>

const SESSION_HREF = /^\/h\/[^/?#]+\/session\/[^/?#]+(?:[?#]|$)/

// The nearest entry already showing this session, count 0 when it is the focused one; null for other hrefs.
export function nativeSessionReturn(
  state: NativeStackState,
  href: string
): NativeSessionReturn | null {
  if (!SESSION_HREF.test(href)) {
    return null
  }
  const wanted = sessionKey(hrefParts(href))
  const match = matchWithin(
    state,
    [],
    (candidate) => candidate !== null && sessionKey(candidate) === wanted
  )
  if (!match?.target || !match.source || !match.routeKey) {
    return null
  }
  return {
    target: match.target,
    source: match.source,
    count: match.count,
    routeKey: match.routeKey
  }
}
