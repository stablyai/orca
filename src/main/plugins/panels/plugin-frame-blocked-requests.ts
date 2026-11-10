/**
 * Requests a plugin frame tried and Orca refused: the guest session cancels everything off the
 * plugin's origin, and the guest's content policy refuses some first. One page can try hundreds
 * (a font CDN, say), so they are counted per kind and origin and logged once per flush, outside
 * the console's line budget, instead of crowding out the plugin's real errors.
 */

export type PluginFrameBlock = { kind: string; origin: string }

/** How long counts gather before they are logged; teardown logs what is left at once. */
export const PLUGIN_FRAME_BLOCKED_FLUSH_MS = 5_000

// Chromium's console text for a content-policy refusal that names a URL: current wording
// ("Loading the font '…' violates …", captured from Electron 43) and older ("Refused to load …").
const CSP_REFUSAL =
  /^(?:Refused to (?:load (?:the \w+|media from)|connect to|frame|create a worker from|prefetch content from)|Loading (?:the \w+|media from)|Connecting to|Framing|Fetching content from) +'([^']+)' (?:because it )?violates the following Content Security Policy directive: "([\w-]+)/
// Names the directive the page left unset when the quoted one is its fallback.
const CSP_FALLBACK_NOTE = /Note that '([\w-]+)' was not explicitly set/

/** At most this many kind-and-origin counts are kept and logged per flush; the rest fold into one
 *  line, so a page trying hundreds of origins cannot flood the plugin's log. */
export const PLUGIN_FRAME_BLOCKED_MAX_LINES = 8
const MAX_BUCKETS = 32

// The resource types Electron reports, as the directive a reader knows them by.
const KIND_BY_RESOURCE_TYPE: Record<string, string> = {
  font: 'font-src',
  script: 'script-src',
  stylesheet: 'style-src',
  image: 'img-src',
  media: 'media-src',
  xhr: 'connect-src',
  webSocket: 'connect-src',
  subFrame: 'frame-src',
  object: 'object-src',
  ping: 'connect-src'
}

function originOf(url: string): string {
  try {
    const { origin, protocol } = new URL(url)
    return origin === 'null' ? protocol : origin
  } catch {
    return url.slice(0, 100)
  }
}

/** A console line that reports a content-policy refusal of a URL, as a block; else null. */
export function pluginFrameCspBlock(message: string): PluginFrameBlock | null {
  const match = CSP_REFUSAL.exec(message)
  if (!match?.[1] || !match[2]) {
    return null
  }
  const kind = CSP_FALLBACK_NOTE.exec(message)?.[1] ?? match[2]
  return { kind, origin: originOf(match[1]) }
}

/** Chromium's console echo of a request already counted: one the session cancelled, or fetch's
 *  repeat of a content-policy refusal. */
export function isPluginFrameCancelledRequestEcho(message: string): boolean {
  return (
    message.startsWith('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT') ||
    /^Fetch API cannot load .* Refused to connect because it violates the document's Content Security Policy/.test(
      message
    )
  )
}

export function pluginFrameRequestBlock(url: string, resourceType: string): PluginFrameBlock {
  return { kind: KIND_BY_RESOURCE_TYPE[resourceType] ?? 'request', origin: originOf(url) }
}

export type PluginFrameBlockedTally = {
  note(block: PluginFrameBlock): void
  /** Logs and clears the counts now. */
  flush(): void
}

export function createPluginFrameBlockedTally(options: {
  log: (line: string) => void
  /** Runs `run` after `ms`; returns a cancel. */
  schedule?: (run: () => void, ms: number) => () => void
}): PluginFrameBlockedTally {
  const schedule =
    options.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms)
      timer.unref()
      return () => clearTimeout(timer)
    })
  const counts = new Map<string, PluginFrameBlock & { count: number }>()
  let overflow = 0
  let cancel: (() => void) | null = null
  const flush = (): void => {
    cancel?.()
    cancel = null
    const ranked = [...counts.values()].sort((a, b) => b.count - a.count)
    for (const { kind, origin, count } of ranked.slice(0, PLUGIN_FRAME_BLOCKED_MAX_LINES)) {
      const times = count > 1 ? ` (x${count})` : ''
      options.log(`[frame] blocked ${kind} ${origin}${times}: plugin frames have no network`)
    }
    for (const { count } of ranked.slice(PLUGIN_FRAME_BLOCKED_MAX_LINES)) {
      overflow += count
    }
    if (overflow > 0) {
      options.log(`[frame] blocked ${overflow} more requests to other origins`)
    }
    counts.clear()
    overflow = 0
  }
  return {
    note(block) {
      const key = `${block.kind} ${block.origin}`
      const entry = counts.get(key)
      if (entry) {
        entry.count += 1
      } else if (counts.size < MAX_BUCKETS) {
        counts.set(key, { ...block, count: 1 })
      } else {
        overflow += 1
      }
      cancel ??= schedule(flush, PLUGIN_FRAME_BLOCKED_FLUSH_MS)
    },
    flush
  }
}
