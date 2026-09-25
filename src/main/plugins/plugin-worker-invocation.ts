/**
 * Entry point from core into a plugin worker's contributions. Every call
 * passes two gates before code runs: the manifest must declare the
 * contribution, and the worker must have registered a handler for it.
 */

import type { PluginTaskSourceMethod } from '../../shared/plugins/plugin-task-source-contract'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'

export type PluginWorkerInvocationHost = {
  /** Null when the plugin is unknown, invalid, or not cleared to run code. */
  resolveRunnablePlugin(pluginKey: string): ValidDiscoveredPlugin | null
  ensureWorker(plugin: ValidDiscoveredPlugin): Promise<PluginWorkerHandle>
}

export type PluginWorkerCommandInvocation = {
  pluginKey: string
  commandId: string
  args: unknown
}

export type PluginWorkerTaskSourceInvocation = {
  pluginKey: string
  sourceId: string
  method: PluginTaskSourceMethod
  params: unknown
}

function runnablePlugin(
  host: PluginWorkerInvocationHost,
  pluginKey: string
): ValidDiscoveredPlugin {
  const plugin = host.resolveRunnablePlugin(pluginKey)
  if (!plugin) {
    throw new Error(`plugin ${pluginKey} is not enabled`)
  }
  return plugin
}

export async function invokePluginWorkerCommand(
  host: PluginWorkerInvocationHost,
  request: PluginWorkerCommandInvocation
): Promise<unknown> {
  const { pluginKey, commandId } = request
  const plugin = runnablePlugin(host, pluginKey)
  const command = plugin.manifest.contributes.commands.find((entry) => entry.id === commandId)
  if (!command) {
    throw new Error(`plugin ${pluginKey} does not contribute command ${commandId}`)
  }
  // Declarative aliases are renderer-owned and must never cross the worker
  // activation boundary, even if a compromised renderer invokes IPC directly.
  if (command.action !== undefined) {
    throw new Error(`plugin ${pluginKey} command ${commandId} is a built-in action alias`)
  }
  const handle = await host.ensureWorker(plugin)
  if (!handle.commands.includes(commandId)) {
    throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
  }
  return handle.invokeCommand(commandId, request.args)
}

export async function invokePluginWorkerTaskSource(
  host: PluginWorkerInvocationHost,
  request: PluginWorkerTaskSourceInvocation
): Promise<unknown> {
  const { pluginKey, sourceId } = request
  const plugin = runnablePlugin(host, pluginKey)
  if (!plugin.manifest.contributes.taskSources.some((entry) => entry.id === sourceId)) {
    throw new Error(`plugin ${pluginKey} does not contribute task source ${sourceId}`)
  }
  const handle = await host.ensureWorker(plugin)
  if (!handle.taskSources.includes(sourceId)) {
    throw new Error(`plugin ${pluginKey} registered no handler for ${sourceId}`)
  }
  return handle.invokeTaskSource(sourceId, request.method, request.params)
}
