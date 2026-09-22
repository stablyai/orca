import type { RouteHandoff } from './route-handoff'

/** What `push`, `replace` and `dismissTo` accept, taken from the router rather than named again. */
export type RouterHref = Parameters<RouteHandoff['push']>[0]

/** Dynamic segments as expo-router writes them in a file name: `[name]` and `[...rest]`. */
const DYNAMIC_SEGMENT = /^\[(?:\.\.\.)?(.+)\]$/

/** `null` is a value expo-router admits in a param list; it names no segment, so it encodes to
 *  nothing rather than to the string "null". */
function encodeSegment(value: string | number | null): string {
  return value === null ? '' : encodeURIComponent(String(value))
}

/**
 * The string form of a router target, resolved the way expo-router resolves it.
 *
 * `String(href)` on the object form is `[object Object]`, and every caller that builds one — the
 * Connection-log link is the live example — would hand that to the shell as a route. Named params
 * fill the dynamic segments they belong to and whatever is left becomes the query, which is what
 * the router itself does with them.
 */
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
        // A dynamic segment nobody supplied stays as it is: the page's own route patterns are
        // written in this same spelling, so it matches one of them and never leaves the document.
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
