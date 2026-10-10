import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerController } from './plugin-worker-controller'

export function assertPluginWorkerCommand(plugin: ValidDiscoveredPlugin, commandId: string): void {
  const command = plugin.manifest.contributes.commands.find((entry) => entry.id === commandId)
  if (!command) {
    throw new Error(`plugin ${plugin.pluginKey} does not contribute command ${commandId}`)
  }
  // Declarative aliases are renderer-owned and must never cross the worker
  // activation boundary, even if a compromised renderer invokes IPC directly.
  if (command.action !== undefined) {
    throw new Error(`plugin ${plugin.pluginKey} command ${commandId} is a built-in action alias`)
  }
}

/** Lazily starts the plugin's worker and runs one of its declared commands. */
export async function invokePluginWorkerCommand(
  workers: Pick<PluginWorkerController, 'ensure'>,
  plugin: ValidDiscoveredPlugin,
  commandId: string,
  args?: unknown
): Promise<unknown> {
  assertPluginWorkerCommand(plugin, commandId)
  const handle = await workers.ensure(plugin)
  if (!handle.commands.includes(commandId)) {
    throw new Error(`plugin ${plugin.pluginKey} registered no handler for ${commandId}`)
  }
  return handle.invokeCommand(commandId, args)
}
