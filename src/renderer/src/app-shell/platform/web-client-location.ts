export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  // Guard partial window.location: launch routing swallows throws, otherwise turning missing locations into silent failures.
  const pathname = (window as { location?: { pathname?: unknown } }).location?.pathname
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    (typeof pathname === 'string' && pathname.endsWith('/web-index.html'))
  )
}
