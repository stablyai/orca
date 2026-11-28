import type { PluginLogLine } from './plugin-log-follower'

/** A log line as dev watch prints it: `count` identical lines, or `repeat`s of one printed earlier. */
export type PluginDevWatchLogLine = PluginLogLine & { count?: number; repeat?: true }

const FRAME_PREFIX = '[frame] '

export const DEFAULT_MAX_FRAME_LOG_DEDUPE_ENTRIES = 1024

const keyOf = (line: PluginLogLine): string => `${line.level}\u0000${line.line}`

/**
 * Panel console lines repeat per item and per render (a warning inside `items.map`), so within one
 * reload each `[frame]` line prints once with how many arrived together; later copies are counted
 * and reported once when evicted from the bounded cache, when the plugin reloads, or when the watch
 * ends. Worker lines pass through as is.
 */
export class PluginFrameLogDedupe {
  private readonly maxEntries: number
  private readonly repeats = new Map<string, { more: number; last: PluginLogLine }>()

  constructor(maxEntries = DEFAULT_MAX_FRAME_LOG_DEDUPE_ENTRIES) {
    this.maxEntries = Number.isFinite(maxEntries)
      ? Math.max(1, Math.floor(maxEntries))
      : DEFAULT_MAX_FRAME_LOG_DEDUPE_ENTRIES
  }

  get size(): number {
    return this.repeats.size
  }

  take(lines: readonly PluginLogLine[]): PluginDevWatchLogLine[] {
    const batch = new Map<string, number>()
    for (const line of lines) {
      if (line.line.startsWith(FRAME_PREFIX)) {
        batch.set(keyOf(line), (batch.get(keyOf(line)) ?? 0) + 1)
      }
    }
    const out: PluginDevWatchLogLine[] = []
    const printed = new Map<string, PluginLogLine>()
    for (const line of lines) {
      const key = keyOf(line)
      const count = batch.get(key)
      if (count === undefined) {
        out.push(line)
        continue
      }
      const seen = this.repeats.get(key)
      if (seen) {
        seen.more += 1
        seen.last = line
        // Refresh recency so active repeating keys survive LRU eviction.
        this.repeats.delete(key)
        this.repeats.set(key, seen)
        continue
      }
      if (!printed.has(key)) {
        printed.set(key, line)
        out.push(count > 1 ? { ...line, count } : line)
      }
    }
    // After the loop, so this batch's own copies count in `count`, not as repeats.
    for (const [key, line] of printed) {
      if (this.repeats.size >= this.maxEntries) {
        const oldest = this.repeats.entries().next().value
        if (oldest) {
          this.repeats.delete(oldest[0])
          if (oldest[1].more > 0) {
            out.push({ ...oldest[1].last, count: oldest[1].more, repeat: true })
          }
        }
      }
      this.repeats.set(key, { more: 0, last: line })
    }
    return out
  }

  /** A reload (or the end of the watch): what repeated since it printed, then a clean slate. */
  flush(): PluginDevWatchLogLine[] {
    const out: PluginDevWatchLogLine[] = []
    for (const { more, last } of this.repeats.values()) {
      if (more > 0) {
        out.push({ ...last, count: more, repeat: true })
      }
    }
    this.repeats.clear()
    return out
  }
}
