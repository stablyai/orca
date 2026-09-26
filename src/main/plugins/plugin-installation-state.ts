import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { readPluginLockfile } from './plugin-install'
import { PluginLogBuffer, type PluginLogLine } from './plugin-log-buffer'

export class PluginInstallationState {
  discovered: DiscoveredPlugin[] = []
  readonly logs = new PluginLogBuffer()
  private removing: DiscoveredPlugin | null = null

  constructor(
    private readonly options: {
      pluginsDir: () => string
      deactivate: (pluginKey: string) => Promise<void>
      notifyChanged: () => void
    }
  ) {}

  isRemoving(plugin: DiscoveredPlugin): boolean {
    return plugin === this.removing
  }

  findValid(pluginKey: string): ValidDiscoveredPlugin | null {
    for (const plugin of this.discovered) {
      if (!isInvalidDiscoveredPlugin(plugin) && plugin.pluginKey === pluginKey) {
        return plugin
      }
    }
    return null
  }

  captureLog(pluginKey: string, level: PluginLogLine['level']): (line: string) => void {
    const log = this.logs.capture(pluginKey)
    return (line) => log(level, line)
  }

  async remove(pluginKey: string, remove: () => Promise<void>): Promise<void> {
    const lock = await readPluginLockfile(this.options.pluginsDir())
    const plugin = this.discovered.find((entry) => entry.pluginKey === pluginKey && !entry.isDev)
    if (!plugin || lock.plugins[pluginKey]?.source.kind === 'bundled') {
      throw new Error(`cannot remove protected or non-installed plugin ${pluginKey}`)
    }
    this.removing = plugin
    try {
      await this.options.deactivate(pluginKey)
      await remove()
      this.logs.clear(pluginKey)
      this.discovered = this.discovered.filter((entry) => entry !== plugin)
      this.options.notifyChanged()
    } finally {
      this.removing = null
    }
  }
}
