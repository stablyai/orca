import type { WebContents } from 'electron'
import {
  parsePluginFrameUrl,
  PLUGIN_FRAME_RESERVED_SEGMENT,
  pluginFrameOrigin
} from '../../../shared/plugins/frames/plugin-frame-guest'

/**
 * Author diagnostics for plugin `<webview>` guests: console errors, warnings and uncaught
 * exceptions go to the plugin's log buffer (`orca plugin logs`), and `orca plugin dev inspect`
 * opens DevTools for its live guests.
 */

export type PluginFrameLogLevel = 'warn' | 'error'
export type PluginFrameLogSink = (
  pluginKey: string
) => ((level: PluginFrameLogLevel, line: string) => void) | null

export type PluginFrameConsoleDetails = {
  level: string
  message: string
  lineNumber: number
  sourceId: string
}

const MESSAGE_CHAR_LIMIT = 2000
// Why per plugin: the log ring holds 200 lines, so a chatty guest would evict worker output.
export const PLUGIN_FRAME_CONSOLE_BURST_LIMIT = 20
export const PLUGIN_FRAME_CONSOLE_WINDOW_MS = 10_000

let logSink: PluginFrameLogSink | null = null
const guestsByPlugin = new Map<string, Set<WebContents>>()
const limiters = new Map<string, () => 'log' | 'notice' | 'drop'>()

export function setPluginFrameGuestLogSink(next: PluginFrameLogSink | null): void {
  logSink = next
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `orca-plugin-frame://<key>/src/panel.tsx?rev=…` becomes `src/panel.tsx`, in stack traces too. */
export function shortenPluginFrameUrls(text: string, frameKey: string): string {
  const origin = new RegExp(
    `${escapeRegExp(pluginFrameOrigin(frameKey))}/([^\\s?#):]*)(?:[?#][^\\s:)]*)?`,
    'g'
  )
  return text.replace(origin, (_match, path: string) => {
    try {
      return decodeURIComponent(path)
    } catch {
      return path
    }
  })
}

/** Plugin-relative `file:line`; null outside this plugin's origin or in an Orca-shipped file,
 *  whose message carries the author's stack instead. */
export function pluginFrameSourceLocation(
  sourceId: string,
  lineNumber: number,
  frameKey: string
): string | null {
  const target = parsePluginFrameUrl(sourceId)
  if (!target || target.frameKey !== frameKey || target.reserved) {
    return null
  }
  const path = target.segments.join('/')
  return lineNumber > 0 ? `${path}:${lineNumber}` : path
}

// After shortening, Orca's own guest files read `__orca/…`; authors only need their own frames.
const ORCA_STACK_FRAME = new RegExp(`^\\s+at (?:.*\\()?${PLUGIN_FRAME_RESERVED_SEGMENT}/`)
// `at Array.forEach (<anonymous>)`, `at new Promise (<anonymous>)`: engine frames with no source.
const SOURCELESS_STACK_FRAME = /^\s+at (?:.*\((?:<anonymous>|native)\)|<anonymous>|native)\s*$/

/** Drops stack lines inside Orca's guest runtime (`__orca/orca-runtime.mjs`) and the engine's. */
export function withoutOrcaStackFrames(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ORCA_STACK_FRAME.test(line) && !SOURCELESS_STACK_FRAME.test(line))
    .join('\n')
}

export function formatPluginFrameConsoleLine(
  details: PluginFrameConsoleDetails,
  frameKey: string
): { level: PluginFrameLogLevel; line: string } | null {
  const level = details.level === 'error' ? 'error' : details.level === 'warning' ? 'warn' : null
  if (!level) {
    return null
  }
  let message = withoutOrcaStackFrames(shortenPluginFrameUrls(details.message, frameKey))
  if (message.length > MESSAGE_CHAR_LIMIT) {
    message = `${message.slice(0, MESSAGE_CHAR_LIMIT)}… (truncated)`
  }
  const location = pluginFrameSourceLocation(details.sourceId, details.lineNumber, frameKey)
  return { level, line: `[frame] ${location ? `${location} ` : ''}${message}` }
}

/** Fixed window: `log` within budget, one `notice` when it runs out, then `drop`. */
export function createPluginFrameConsoleLimiter(
  now: () => number = Date.now
): () => 'log' | 'notice' | 'drop' {
  let windowStart = Number.NEGATIVE_INFINITY
  let count = 0
  return () => {
    const at = now()
    if (at - windowStart >= PLUGIN_FRAME_CONSOLE_WINDOW_MS) {
      windowStart = at
      count = 0
    }
    count += 1
    if (count <= PLUGIN_FRAME_CONSOLE_BURST_LIMIT) {
      return 'log'
    }
    return count === PLUGIN_FRAME_CONSOLE_BURST_LIMIT + 1 ? 'notice' : 'drop'
  }
}

function limiterFor(pluginKey: string): () => 'log' | 'notice' | 'drop' {
  let limiter = limiters.get(pluginKey)
  if (!limiter) {
    limiter = createPluginFrameConsoleLimiter()
    limiters.set(pluginKey, limiter)
  }
  return limiter
}

/** `did-attach-webview`, after the guest policies: routes its console and tracks it for inspect. */
export function installPluginFrameGuestDiagnostics(
  guest: WebContents,
  frameKey: string,
  pluginKey: string
): void {
  let guests = guestsByPlugin.get(pluginKey)
  if (!guests) {
    guests = new Set()
    guestsByPlugin.set(pluginKey, guests)
  }
  guests.add(guest)
  guest.once('destroyed', () => {
    const live = guestsByPlugin.get(pluginKey)
    live?.delete(guest)
    if (live?.size === 0) {
      guestsByPlugin.delete(pluginKey)
    }
  })
  const log = logSink?.(pluginKey)
  if (!log) {
    return
  }
  // Uncaught exceptions and unhandled rejections arrive here too, as `Uncaught …` errors.
  guest.on('console-message', (details) => {
    const formatted = formatPluginFrameConsoleLine(details, frameKey)
    if (!formatted) {
      return
    }
    const verdict = limiterFor(pluginKey)()
    if (verdict === 'log') {
      log(formatted.level, formatted.line)
    } else if (verdict === 'notice') {
      log(
        'warn',
        `[frame] more than ${PLUGIN_FRAME_CONSOLE_BURST_LIMIT} console messages in ${PLUGIN_FRAME_CONSOLE_WINDOW_MS / 1000}s; dropping the rest of this window`
      )
    }
  })
}

/** Explicit user command only: DevTools is a window of its own. Returns how many it opened. */
export function openPluginFrameGuestDevTools(pluginKey: string): number {
  let opened = 0
  for (const guest of guestsByPlugin.get(pluginKey) ?? []) {
    if (!guest.isDestroyed()) {
      guest.openDevTools({ mode: 'detach' })
      opened += 1
    }
  }
  return opened
}

/** The plugin's live guests, for `orca plugin shot` to wait on the one it captures. */
export function livePluginFrameGuests(pluginKey: string): WebContents[] {
  return [...(guestsByPlugin.get(pluginKey) ?? [])].filter((guest) => !guest.isDestroyed())
}
