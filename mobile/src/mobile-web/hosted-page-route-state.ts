// Only page-owned, durable route names belong here; document-scoped resource handles do not.
const HOSTED_PAGE_ROUTES = new Set([
  '/settings',
  '/about',
  '/native-chat-settings',
  '/browser-settings',
  '/troubleshoot',
  '/connection-log',
  '/notifications',
  '/voice-settings',
  '/terminal-settings'
])

export function hostedPageRouteState(pathname: string): string | undefined {
  return HOSTED_PAGE_ROUTES.has(pathname) ? JSON.stringify({ version: 1, pathname }) : undefined
}

export function hostedPageStateTarget(pageState: string | undefined): string | undefined {
  if (!pageState) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(pageState)
    if (value === null || typeof value !== 'object') {
      return undefined
    }
    const state = value as Record<string, unknown>
    return state.version === 1 &&
      typeof state.pathname === 'string' &&
      HOSTED_PAGE_ROUTES.has(state.pathname)
      ? state.pathname
      : undefined
  } catch {
    return undefined
  }
}
