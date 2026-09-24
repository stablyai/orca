export type PluginLogLine = { ts: number; level: 'info' | 'warn' | 'error'; line: string }

const LOG_RING_LIMIT = 200
export const PLUGIN_LOG_KEY_LIMIT = 256

export class PluginLogBuffer {
  private readonly logs = new Map<string, { token: object; lines: PluginLogLine[] }>()

  get(pluginKey: string): PluginLogLine[] {
    return this.logs.get(pluginKey)?.lines ?? []
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

  private ensure(pluginKey: string): { token: object; lines: PluginLogLine[] } {
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
    ring.push({ ts: Date.now(), level, line })
    if (ring.length > LOG_RING_LIMIT) {
      ring.splice(0, ring.length - LOG_RING_LIMIT)
    }
  }
}
