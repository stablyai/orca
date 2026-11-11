/** Home's param naming the desktop its Agents tab opens filtered to. */
export const HOME_AGENTS_PARAM = 'agents'

// Older apps' Home ignores the param and the shell pushes it as a second Home, so pages offer the link only under this grant.
export const HOME_AGENTS_ROUTE_GRANT = 'homeAgentsRoute'

export function homeAgentsHref(hostId: string): string {
  return `/?${HOME_AGENTS_PARAM}=${encodeURIComponent(hostId)}`
}

export function isHomeRoute(href: string): boolean {
  return href.split(/[?#]/)[0] === '/'
}
