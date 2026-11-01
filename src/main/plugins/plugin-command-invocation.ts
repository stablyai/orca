import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerController } from './workers/plugin-worker-controller'

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

/** `plugin` is the approved plugin (null when it is not): a palette or CLI run of its command. */
export async function invokePluginWorkerCommand(
  pluginKey: string,
  plugin: ValidDiscoveredPlugin | null,
  workers: Pick<PluginWorkerController, 'ensure'>,
  commandId: string,
  args?: unknown
): Promise<unknown> {
  if (!plugin) {
    throw new Error(`plugin ${pluginKey} is not enabled`)
  }
  assertPluginWorkerCommand(plugin, commandId)
  const handle = await workers.ensure(plugin)
  if (!handle.commands.includes(commandId)) {
    throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
  }
  return handle.invokeCommand(commandId, args)
}
