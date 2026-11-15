import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import type { PluginWorkerController } from '../workers/plugin-worker-controller'
import { runPluginReplacementWithinDeadline } from './plugin-command-replacement-deadline'

export function assertPluginWorkerCommand(
  plugin: ValidDiscoveredPlugin,
  commandId: string
): ValidDiscoveredPlugin['manifest']['contributes']['commands'][number] {
  const command = plugin.manifest.contributes.commands.find((entry) => entry.id === commandId)
  if (!command) {
    throw new Error(`plugin ${plugin.pluginKey} does not contribute command ${commandId}`)
  }
  // Renderer-owned action aliases cannot activate workers, even through direct IPC.
  if (command.action !== undefined) {
    throw new Error(`plugin ${plugin.pluginKey} command ${commandId} is a built-in action alias`)
  }
  return command
}

/** `plugin` is the approved plugin (null when it is not): a palette or CLI run of its command. */
export async function invokePluginWorkerCommand(
  pluginKey: string,
  plugin: ValidDiscoveredPlugin | null,
  workers: Pick<PluginWorkerController, 'ensure'>,
  commandId: string,
  args?: unknown,
  /** Epoch ms past which the caller stopped waiting, so a slow start must not run it late. */
  startBy?: number
): Promise<unknown> {
  if (!plugin) {
    throw new Error(`plugin ${pluginKey} is not enabled`)
  }
  const command = assertPluginWorkerCommand(plugin, commandId)
  const handle = await workers.ensure(plugin)
  if (!handle.commands.includes(commandId)) {
    throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
  }
  if (startBy !== undefined && Date.now() > startBy) {
    throw new Error(`plugin ${pluginKey} started too late to run ${commandId}`)
  }
  if (startBy !== undefined && command.replaces !== undefined) {
    // Why: past startBy the renderer runs Orca's own action, so a handler that finishes later
    // must not run it again through commands.run.
    return runPluginReplacementWithinDeadline(pluginKey, command.replaces, startBy, () =>
      handle.invokeCommand(commandId, args)
    )
  }
  return handle.invokeCommand(commandId, args)
}
