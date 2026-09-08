const MAX_ROUTE_QUERY_KEYS = 32
const MAX_ROUTE_QUERY_KEY_LENGTH = 64
const MAX_ROUTE_QUERY_VALUE_LENGTH = 16_384

const queryByPathname = new Map<string, Readonly<Record<string, string>>>()

export function rememberMobileWebRouteQuery(
  pathname: string,
  query: URLSearchParams | Readonly<Record<string, string | undefined>>
): void {
  const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query)
  const remembered: Record<string, string> = {}
  let count = 0
  for (const [key, value] of entries) {
    if (
      value === undefined ||
      count >= MAX_ROUTE_QUERY_KEYS ||
      key.length === 0 ||
      key.length > MAX_ROUTE_QUERY_KEY_LENGTH ||
      value.length > MAX_ROUTE_QUERY_VALUE_LENGTH
    ) {
      continue
    }
    remembered[key] = value
    count += 1
  }
  if (count === 0) {
    queryByPathname.delete(pathname)
    return
  }
  queryByPathname.set(pathname, Object.freeze(remembered))
}

export function mobileWebRouteQuery(pathname: string): Readonly<Record<string, string>> {
  return queryByPathname.get(pathname) ?? {}
}
