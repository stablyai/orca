import type { LogsResult } from '../handlers/plugin-runtime'

export type PluginLogLine = LogsResult['lines'][number]

/**
 * Turns repeated `plugins.getLogs` replies into only the lines not yet seen. Hosts with the
 * `after` cursor send just those; older hosts send their whole ring, which is ordered by time,
 * so lines past the last timestamp seen (and past those already seen at it) are new.
 */
export class PluginLogFollower {
  private hostCursor: string | undefined
  private lastTs = Number.NEGATIVE_INFINITY
  private seenAtLastTs = 0

  /** Pass as `after`; undefined until a host that supports it replied. */
  get cursor(): string | undefined {
    return this.hostCursor
  }

  take(reply: LogsResult): PluginLogLine[] {
    if (typeof reply.cursor === 'string') {
      this.hostCursor = reply.cursor
      return reply.lines
    }
    const fresh: PluginLogLine[] = []
    let skipAtLastTs = this.seenAtLastTs
    for (const line of reply.lines) {
      if (line.ts < this.lastTs) {
        continue
      }
      if (line.ts === this.lastTs && skipAtLastTs > 0) {
        skipAtLastTs -= 1
        continue
      }
      fresh.push(line)
    }
    for (const line of fresh) {
      this.seenAtLastTs = line.ts === this.lastTs ? this.seenAtLastTs + 1 : 1
      this.lastTs = line.ts
    }
    return fresh
  }
}
