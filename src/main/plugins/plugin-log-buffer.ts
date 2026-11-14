import { randomBytes } from 'node:crypto'

export type PluginLogLine = { ts: number; level: 'info' | 'warn' | 'error'; line: string }
type StoredLogLine = PluginLogLine & { seq: number }

// Why a run nonce: seq restarts with the host, and a cursor from the last run must not skip lines.
const LOG_CURSOR_NONCE = randomBytes(4).toString('hex')
let lastLogSeq = 0

function cursorSeq(cursor: string | undefined): number | null {
  const [nonce, seq] = cursor?.split(':') ?? []
  const parsed = Number(seq)
  return nonce === LOG_CURSOR_NONCE && Number.isSafeInteger(parsed) ? parsed : null
}

const toLogLine = ({ ts, level, line }: StoredLogLine): PluginLogLine => ({ ts, level, line })

const LOG_RING_LIMIT = 200
export const PLUGIN_LOG_KEY_LIMIT = 256

export class PluginLogBuffer {
  private readonly logs = new Map<string, { token: object; lines: StoredLogLine[] }>()

  get(pluginKey: string): PluginLogLine[] {
    return (this.logs.get(pluginKey)?.lines ?? []).map(toLogLine)
  }

  /** Lines after an opaque cursor from an earlier call (all lines for a stale or absent one). */
  since(pluginKey: string, cursor?: string): { lines: PluginLogLine[]; cursor: string } {
    const after = cursorSeq(cursor) ?? -1
    const lines = (this.logs.get(pluginKey)?.lines ?? []).filter((line) => line.seq > after)
    return { lines: lines.map(toLogLine), cursor: `${LOG_CURSOR_NONCE}:${lastLogSeq}` }
  }

  get size(): number {
    return this.logs.size
  }

  capture(pluginKey: string): (level: PluginLogLine['level'], line: string) => void {
    const token = this.ensure(pluginKey).token
    return (level, line) => {
      if (this.logs.get(pluginKey)?.token === token) {
        this.append(pluginKey, level, line)
      }
    }
  }

  clear(pluginKey: string): void {
    this.logs.delete(pluginKey)
  }

  private ensure(pluginKey: string): { token: object; lines: StoredLogLine[] } {
    let entry = this.logs.get(pluginKey)
    if (!entry) {
      entry = { token: {}, lines: [] }
      this.logs.set(pluginKey, entry)
      while (this.logs.size > PLUGIN_LOG_KEY_LIMIT) {
        const oldest = this.logs.keys().next()
        if (oldest.done) {
          break
        }
        this.logs.delete(oldest.value)
      }
    }
    return entry
  }

  append(pluginKey: string, level: PluginLogLine['level'], line: string): void {
    const ring = this.ensure(pluginKey).lines
    lastLogSeq += 1
    ring.push({ ts: Date.now(), level, line, seq: lastLogSeq })
    if (ring.length > LOG_RING_LIMIT) {
      ring.splice(0, ring.length - LOG_RING_LIMIT)
    }
  }
}
