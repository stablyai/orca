/**
 * Requests a plugin frame tried and Orca refused: the guest session cancels everything off the
 * plugin's origin, and the guest's content policy refuses some first. One page can try hundreds
 * (a font CDN, say), so they are counted per kind and origin and logged once per flush, outside
 * the console's line budget, instead of crowding out the plugin's real errors.
 */

export type PluginFrameBlock = { kind: string; origin: string }

/** How long counts gather before they are logged; teardown logs what is left at once. */
export const PLUGIN_FRAME_BLOCKED_FLUSH_MS = 5_000

// Chromium's console text for a content-policy refusal that names a URL.
const CSP_REFUSAL =
  /^Refused to (?:load (?:the \w+|media from)|connect to|frame|create a worker from|prefetch content from) '([^']+)' because it violates the following Content Security Policy directive: "([\w-]+)/

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
  return match?.[1] && match[2] ? { kind: match[2], origin: originOf(match[1]) } : null
}

/** Chromium's console echo of a request the session cancelled, already counted by the session. */
export function isPluginFrameCancelledRequestEcho(message: string): boolean {
  return message.startsWith('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT')
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
  let cancel: (() => void) | null = null
  const flush = (): void => {
    cancel?.()
    cancel = null
    for (const { kind, origin, count } of counts.values()) {
      const times = count > 1 ? ` (x${count})` : ''
      options.log(`[frame] blocked ${kind} ${origin}${times}: plugin frames have no network`)
    }
    counts.clear()
  }
  return {
    note(block) {
      const key = `${block.kind} ${block.origin}`
      const entry = counts.get(key)
      if (entry) {
        entry.count += 1
      } else {
        counts.set(key, { ...block, count: 1 })
      }
      cancel ??= schedule(flush, PLUGIN_FRAME_BLOCKED_FLUSH_MS)
    },
    flush
  }
}
