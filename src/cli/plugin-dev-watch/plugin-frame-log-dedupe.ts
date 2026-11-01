import type { PluginLogLine } from './plugin-log-follower'

/** A log line as dev watch prints it: `count` identical lines, or `repeat`s of one printed earlier. */
export type PluginDevWatchLogLine = PluginLogLine & { count?: number; repeat?: true }

const FRAME_PREFIX = '[frame] '

const keyOf = (line: PluginLogLine): string => `${line.level}\u0000${line.line}`

/**
 * Panel console lines repeat per item and per render (a warning inside `items.map`), so within one
 * reload each `[frame]` line prints once with how many arrived together; later copies are counted
 * and reported once when the plugin reloads or the watch ends. Worker lines pass through as is.
 */
export class PluginFrameLogDedupe {
  private readonly repeats = new Map<string, { more: number; last: PluginLogLine }>()

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
        continue
      }
      if (!printed.has(key)) {
        printed.set(key, line)
        out.push(count > 1 ? { ...line, count } : line)
      }
    }
    // After the loop, so this batch's own copies count in `count`, not as repeats.
    for (const [key, line] of printed) {
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
