type RouteParams = Readonly<Record<string, string | string[] | undefined>>

// expo-router's pathname joins raw param values; a worktree id holds slashes, so encode each dynamic segment or the native router matches another screen.
export function encodedRouteHref(segments: readonly string[], params: RouteParams): string {
  const parts = segments.flatMap((segment) => {
    if (segment.startsWith('(') && segment.endsWith(')')) {
      return []
    }
    const rest = /^\[\.\.\.(.+)\]$/.exec(segment)?.[1]
    const name = rest ?? /^\[(.+)\]$/.exec(segment)?.[1]
    if (name === undefined) {
      return [segment]
    }
    const value = params[name]
    const values = value === undefined ? [] : Array.isArray(value) ? value : [value]
    return values.map(encodeURIComponent)
  })
  return `/${parts.join('/')}`
}
