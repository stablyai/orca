import {
  parsePluginTaskSourceResult,
  pluginTaskSourceRequestSchema,
  type PluginTaskDetail,
  type PluginTaskListResult
} from '../../shared/plugins/tasks/plugin-task-source'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerController } from './workers/plugin-worker-controller'

/** Null unless the plugin is installed, approved, and allowed to start work. */
export type PluginApprovedLookup = {
  findApprovedPlugin(pluginKey: string): ValidDiscoveredPlugin | null
}

/** Runs one task-source operation in the plugin's worker. Both the request
 *  (from a renderer or paired client) and the worker's answer are untrusted. */
export async function invokePluginTaskSource(
  plugins: PluginApprovedLookup,
  workers: Pick<PluginWorkerController, 'ensure'>,
  rawRequest: unknown
): Promise<PluginTaskListResult | PluginTaskDetail> {
  const request = pluginTaskSourceRequestSchema.parse(rawRequest)
  const { pluginKey, sourceId, operation } = request
  const plugin = plugins.findApprovedPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`plugin ${pluginKey} is not enabled`)
  }
  if (!plugin.manifest.contributes.taskSources.some((source) => source.id === sourceId)) {
    throw new Error(`plugin ${pluginKey} does not contribute task source ${sourceId}`)
  }
  // Why: manifest validation already pairs taskSources with this capability;
  // re-check so a future validation gap cannot open an unconsented source.
  if (!plugin.manifest.capabilities.some((capability) => capability.kind === 'tasks:provide')) {
    throw new Error(`plugin ${pluginKey} is not allowed to provide tasks`)
  }
  const handle = await workers.ensure(plugin)
  if (!handle.taskSources.includes(sourceId)) {
    throw new Error(`plugin ${pluginKey} registered no handler for task source ${sourceId}`)
  }
  const raw = await handle.invokeTaskSource(sourceId, operation, request.params)
  const parsed = parsePluginTaskSourceResult(operation, raw)
  if (!parsed.ok) {
    throw new Error(`plugin ${pluginKey} returned an invalid ${operation} result: ${parsed.error}`)
  }
  return parsed.value
}
