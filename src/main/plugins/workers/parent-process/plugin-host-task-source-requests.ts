import { PLUGIN_TASK_SOURCE_INVOKE_TIMEOUT_MS } from '../../../../shared/plugins/tasks/plugin-task-source'
import { WORKER_METHODS } from '../../../../shared/plugins/workers/plugin-host-protocol'
import type { PluginWorkerHandle } from './plugin-host-process-types'
import { sendPluginWorkerRequest, type PluginWorkerRequestChannel } from './plugin-worker-requests'

/** The handle's task-source half: the ids the worker registered, and calls into them. */
export function pluginWorkerTaskSourceRequests(
  requests: PluginWorkerRequestChannel,
  taskSources: readonly string[],
  timeoutMs = PLUGIN_TASK_SOURCE_INVOKE_TIMEOUT_MS
): Pick<PluginWorkerHandle, 'taskSources' | 'invokeTaskSource'> {
  return {
    taskSources,
    invokeTaskSource(sourceId, operation, params) {
      return sendPluginWorkerRequest(
        requests,
        WORKER_METHODS.invokeTaskSource,
        { sourceId, operation, params },
        timeoutMs,
        `task source ${sourceId}.${operation}`
      )
    }
  }
}
