import { BROWSER_CLIENT_PAGE_ROWS_CLIENT_CAPABILITY } from '../../../../src/shared/browser/runtime/browser-runtime-capabilities'
import { MOBILE_WEB_PAGE_VERSION_SHOWS_CLIENT_HOST_ROWS } from '../web-bundle/mobile-web-bundle-compat'

// The host's page, not this shell, draws what these capabilities unlock; an older cached page would mount a
// streamed pane for a This-device tab and fail. Advertise each only while the page loaded for that host declares it.
const PAGE_DRAWN_CAPABILITIES = [
  {
    capability: BROWSER_CLIENT_PAGE_ROWS_CLIENT_CAPABILITY,
    sincePageVersion: MOBILE_WEB_PAGE_VERSION_SHOWS_CLIENT_HOST_ROWS
  }
] as const

const capabilitiesByHost = new Map<string, readonly string[]>()
const listenersByHost = new Map<string, Set<() => void>>()

/** What the page loaded for this host can draw; none until a page has loaded. */
export function pageClientCapabilities(hostId: string | undefined): readonly string[] {
  return (hostId && capabilitiesByHost.get(hostId)) || []
}

export function sameClientCapabilities(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((capability, i) => capability === b[i])
}

export function notePageVersion(hostId: string, pageVersion: number): void {
  const next = PAGE_DRAWN_CAPABILITIES.filter((entry) => pageVersion >= entry.sincePageVersion).map(
    (entry) => entry.capability
  )
  if (sameClientCapabilities(pageClientCapabilities(hostId), next)) {
    return
  }
  capabilitiesByHost.set(hostId, next)
  for (const listener of listenersByHost.get(hostId) ?? []) {
    listener()
  }
}

/** Connected sockets re-advertise when the page changes; reconnects read the current list. */
export function watchPageClientCapabilities(
  hostId: string | undefined,
  listener: () => void
): () => void {
  if (!hostId) {
    return () => {}
  }
  const listeners = listenersByHost.get(hostId) ?? new Set<() => void>()
  listeners.add(listener)
  listenersByHost.set(hostId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByHost.delete(hostId)
    }
  }
}
