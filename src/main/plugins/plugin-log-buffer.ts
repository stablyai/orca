export type PluginLogLine = { ts: number; level: 'info' | 'warn' | 'error'; line: string }

const LOG_RING_LIMIT = 200

export class PluginLogBuffer {
  private readonly logs = new Map<string, PluginLogLine[]>()

  get(pluginKey: string): PluginLogLine[] {
    return this.logs.get(pluginKey) ?? []
  }

  append(pluginKey: string, level: PluginLogLine['level'], line: string): void {
    const ring = this.logs.get(pluginKey) ?? []
    ring.push({ ts: Date.now(), level, line })
    if (ring.length > LOG_RING_LIMIT) {
      ring.splice(0, ring.length - LOG_RING_LIMIT)
    }
    this.logs.set(pluginKey, ring)
  }
}
