// Browser action recorder — event-stream filter helpers (dedup, noise, challenges).
import type { ConsoleMessageDetails } from './browser-console-streak'

/** Turnstile/Cloudflare challenge traffic — page-level noise, not app flow. */
export function isChallengeRequest(url: string, origin: string): boolean {
  const haystack = `${url} ${origin}`
  return (
    haystack.includes('/cdn-cgi/challenge-platform/') ||
    haystack.includes('challenges.cloudflare.com')
  )
}

export function requestKey(url: string, method: string): string {
  // Why: the page hook reports relative URLs while webRequest reports
  // absolute ones — normalize both to path+search so dedup matches.
  // Decode the search too: one path percent-encodes (filter=Servis%20Hareket),
  // the other sends it raw (filter=Servis Hareket Raporu), and those must
  // dedupe against each other.
  try {
    const parsed = new URL(url, 'http://localhost')
    let search = parsed.search
    try {
      search = decodeURIComponent(search)
    } catch {
      // malformed percent-encoding — keep as-is
    }
    return `${method}|${parsed.pathname}${search}`
  } catch {
    return `${method}|${url}`
  }
}

/** Filters app console chatter so real messages stay visible. */
export function isConsoleNoise(details: ConsoleMessageDetails): boolean {
  if (details.level === 'debug') {
    return true
  }
  const message = (details.message ?? '').trim()
  if (message.length < 3) {
    return true
  }
  // Why: errors and warnings are the reason the recorder watches the console —
  // never filter them out as token-shaped chatter.
  if (details.level === 'error' || details.level === 'warning') {
    return false
  }
  if (message === '[object Object]') {
    return true
  }
  // "1 null", "42 false" — app-internal counter reports.
  if (/^\d+\s+(null|false|true|undefined)$/i.test(message)) {
    return true
  }
  // Why: framework/page chatter that adds no flow value — WebGL driver
  // warnings, Turnstile/Cloudflare token logs, console.group bookkeeping,
  // %c-formatted style probes, and short token-like strings.
  if (
    message.startsWith('WebGL:') ||
    message.startsWith('WebGL INVALID') ||
    message.startsWith('console.group') ||
    message.startsWith('%c') ||
    message === '[object HTMLAnchorElement]' ||
    message.startsWith('service ') ||
    // Why: token-shaped one-liners ('a1b2c3') without a message part; real
    // 'TypeError: x' style messages carry a ': ' suffix and are kept.
    /^[A-Za-z0-9]{3,16}$/.test(message)
  ) {
    return true
  }
  return false
}
