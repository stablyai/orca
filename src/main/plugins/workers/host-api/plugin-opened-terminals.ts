/**
 * Terminals each plugin opened itself (`terminal.create`, `agent.launch`), which it may close
 * wherever they are. Bounded per plugin, oldest forgotten first; cleared when the plugin's worker
 * stops or the plugin is disabled or removed, so a restarted or reinstalled plugin starts with none.
 */

export const PLUGIN_OPENED_TERMINAL_LIMIT = 128

const openedByPlugin = new Map<string, Set<string>>()

export function recordPluginOpenedTerminal(pluginId: string, terminalId: string): void {
  const opened = openedByPlugin.get(pluginId) ?? new Set<string>()
  opened.delete(terminalId)
  opened.add(terminalId)
  if (opened.size > PLUGIN_OPENED_TERMINAL_LIMIT) {
    const oldest = opened.values().next()
    if (!oldest.done) {
      opened.delete(oldest.value)
    }
  }
  openedByPlugin.set(pluginId, opened)
}

export function isPluginOpenedTerminal(pluginId: string, terminalId: string): boolean {
  return openedByPlugin.get(pluginId)?.has(terminalId) === true
}

export function forgetPluginOpenedTerminal(pluginId: string, terminalId: string): void {
  openedByPlugin.get(pluginId)?.delete(terminalId)
}

export function clearPluginOpenedTerminals(pluginId: string): void {
  openedByPlugin.delete(pluginId)
}

/** Drops every plugin `keep` rejects. */
export function prunePluginOpenedTerminals(keep: (pluginId: string) => boolean): void {
  for (const pluginId of openedByPlugin.keys()) {
    if (!keep(pluginId)) {
      openedByPlugin.delete(pluginId)
    }
  }
}

type PluginLifecycleSource = {
  onChanged(listener: () => void): () => void
  findApprovedPlugin(pluginKey: string, allowRefreshPause?: boolean): unknown
  workerState(pluginKey: string): { state: 'inactive' | 'running' | 'restarting' | 'errored' }
}

/** Forgets a plugin's terminals once its worker stops (deactivated, reaped, errored) or it is
 *  disabled or removed: every one of those notifies a change. */
export function installPluginOpenedTerminalPruning(service: PluginLifecycleSource): () => void {
  return service.onChanged(() =>
    prunePluginOpenedTerminals((pluginKey) => {
      const { state } = service.workerState(pluginKey)
      return (
        service.findApprovedPlugin(pluginKey, true) !== null &&
        (state === 'running' || state === 'restarting')
      )
    })
  )
}
