import type { PluginWorkerHostCallExecutor } from './parent-process/plugin-host-process-types'
import type { PluginWorkerPanelPost } from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import type { PluginWorkerFactory } from './worker-supervision/plugin-worker-startup'

export type PluginWorkerManagerOptions = {
  entryPath: string
  maxActive?: number
  idleReapMs?: number
  workerFactory?: PluginWorkerFactory
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown,
    signal?: AbortSignal
  ) => ReturnType<PluginWorkerHostCallExecutor>
  onPanelPost?: (pluginKey: string, post: PluginWorkerPanelPost) => void
  log: (pluginKey: string) => (level: 'info' | 'warn' | 'error', line: string) => void
  onWorkerStateChange: (pluginKey: string) => void
}
