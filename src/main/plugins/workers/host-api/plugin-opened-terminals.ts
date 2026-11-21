/**
 * Terminals each plugin opened itself (`terminal.create`, `agent.launch`), which it may close
 * wherever they are. Bounded per plugin, oldest forgotten first; cleared when the plugin is
 * disabled or removed, so a re-enabled or reinstalled plugin starts with none.
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

type PluginApprovalSource = {
  onChanged(listener: () => void): () => void
  findApprovedPlugin(pluginKey: string, allowRefreshPause?: boolean): unknown
}

/** Forgets a plugin's terminals once it is disabled, loses consent or is removed: each notifies a
 *  change. Why not on worker stop: an event-driven worker is reaped and restarted between events,
 *  and must still close what it opened. */
export function installPluginOpenedTerminalPruning(service: PluginApprovalSource): () => void {
  return service.onChanged(() =>
    prunePluginOpenedTerminals((pluginKey) => service.findApprovedPlugin(pluginKey, true) !== null)
  )
}
