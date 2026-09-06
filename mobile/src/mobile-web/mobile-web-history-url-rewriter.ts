import { rememberMobileWebRouteQuery } from './mobile-web-route-query-cache'

type MobileWebHistoryWriter = (data: unknown, unused: string, url?: string | URL | null) => void

export type MobileWebHistoryLocation = {
  hash: string
  href: string
  origin: string
}

export type MobileWebHistoryTarget = {
  history: {
    pushState: MobileWebHistoryWriter
    replaceState: MobileWebHistoryWriter
  }
  location: MobileWebHistoryLocation
}

export type MobileWebHistoryUrlRewrite = (
  candidate: URL,
  location: MobileWebHistoryLocation
) => void

const SHELL_SESSION_FRAGMENT_PATTERN = /^#[A-Za-z0-9_-]{43}$/

const installedHistories = new WeakSet<object>()

/** The native shell hands the page its session in the fragment; every same-origin write keeps it. */
export const pinMobileWebShellSessionFragment: MobileWebHistoryUrlRewrite = (
  candidate,
  location
) => {
  if (SHELL_SESSION_FRAGMENT_PATTERN.test(location.hash)) {
    candidate.hash = location.hash
  }
}

/** Route params live in memory so the visible URL never carries them. */
export const stripMobileWebRouteQuery: MobileWebHistoryUrlRewrite = (candidate) => {
  rememberMobileWebRouteQuery(candidate.pathname, candidate.searchParams)
  candidate.search = ''
}

export function installMobileWebHistoryUrlRewriter(
  rewrites: readonly MobileWebHistoryUrlRewrite[],
  target: MobileWebHistoryTarget = window
): boolean {
  const { history, location } = target
  if (installedHistories.has(history)) {
    return false
  }
  history.pushState = rewritingHistoryWriter(history, history.pushState, location, rewrites)
  history.replaceState = rewritingHistoryWriter(history, history.replaceState, location, rewrites)
  installedHistories.add(history)
  return true
}

function rewritingHistoryWriter(
  history: MobileWebHistoryTarget['history'],
  writer: MobileWebHistoryWriter,
  location: MobileWebHistoryLocation,
  rewrites: readonly MobileWebHistoryUrlRewrite[]
): MobileWebHistoryWriter {
  return (data, unused, url) => {
    writer.call(history, data, unused, rewrittenHistoryUrl(url, location, rewrites))
  }
}

function rewrittenHistoryUrl(
  value: string | URL | null | undefined,
  location: MobileWebHistoryLocation,
  rewrites: readonly MobileWebHistoryUrlRewrite[]
): string | URL | null | undefined {
  if (value == null) {
    return value
  }
  try {
    const candidate = new URL(String(value), location.href)
    if (candidate.origin !== location.origin) {
      return value
    }
    for (const rewrite of rewrites) {
      rewrite(candidate, location)
    }
    return candidate.href
  } catch {
    return value
  }
}
