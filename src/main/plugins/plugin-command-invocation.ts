import type { ValidDiscoveredPlugin } from './plugin-discovery'

export function assertPluginWorkerCommand(plugin: ValidDiscoveredPlugin, commandId: string): void {
  const command = plugin.manifest.contributes.commands.find((entry) => entry.id === commandId)
  if (!command) {
    throw new Error(`plugin ${plugin.pluginKey} does not contribute command ${commandId}`)
  }
  // Renderer-owned action aliases cannot activate workers, even through direct IPC.
  if (command.action !== undefined) {
    throw new Error(`plugin ${plugin.pluginKey} command ${commandId} is a built-in action alias`)
  }
}
