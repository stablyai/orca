import type { RouteHandoff } from './route-handoff'

export type RouterHref = Parameters<RouteHandoff['push']>[0]

const DYNAMIC_SEGMENT = /^\[(?:\.\.\.)?(.+)\]$/

// Expo permits null params; encode them as empty segments instead of literal null.
function encodeSegment(value: string | number | null): string {
  return value === null ? '' : encodeURIComponent(String(value))
}

// Resolve object hrefs like Expo: fill dynamic path segments and send remaining params as query; String(object) is not a route.
export function stringifyRouteHref(href: RouterHref): string {
  if (typeof href === 'string') {
    return href
  }
  const remaining = new Map(Object.entries(href.params ?? {}))
  const path = href.pathname
    .split('/')
    .map((segment) => {
      const name = DYNAMIC_SEGMENT.exec(segment)?.[1]
      if (name === undefined || !remaining.has(name)) {
        // Keep unsupplied dynamic segments in manifest-pattern spelling for local matching.
        return segment
      }
      const value = remaining.get(name)
      remaining.delete(name)
      if (value === undefined) {
        return segment
      }
      return Array.isArray(value) ? value.map(encodeSegment).join('/') : encodeSegment(value)
    })
    .join('/')
  const query = new URLSearchParams()
  for (const [key, value] of remaining) {
    if (value === undefined) {
      continue
    }
    for (const one of Array.isArray(value) ? value : [value]) {
      query.append(key, String(one))
    }
  }
  const search = query.toString()
  return search === '' ? path : `${path}?${search}`
}
