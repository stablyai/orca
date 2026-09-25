import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import {
  PLUGIN_COMMAND_EXTENSION_POINT,
  PLUGIN_TASK_SOURCE_EXTENSION_POINT,
  type PluginExtensionRegistry
} from '../../shared/plugins/plugin-extension-registry'
import {
  PLUGIN_TASK_SOURCE_RESULT_SCHEMAS,
  type PluginTaskSourceMethod
} from '../../shared/plugins/plugin-task-source-contract'
import { invokePluginTaskSourceMethod } from './plugin-task-source-invoker'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { resolveContainedPluginArtifact } from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import {
  PluginWorkerManager,
  type PluginWorkerFactory,
  type PluginWorkerSpawnSpec
} from './plugin-worker-manager'
import { buildPluginWorkerSpawnSpec, pluginWorkerSpawnSpecsEqual } from './plugin-worker-spawn-spec'
import type { PluginWorkerHandle } from './plugin-host-process'
import type { PluginRunState } from './plugin-supervisor'

export type PluginWorkerControllerOptions = {
  entryPath: string
  maxActive?: number
  idleReapMs?: number
  workerFactory?: PluginWorkerFactory
  registry: PluginExtensionRegistry
  contentVerifier: PluginContentVerifier
  capabilities: (pluginKey: string) => readonly PluginCapabilityKind[] | null
  isCurrentApproved: (plugin: ValidDiscoveredPlugin) => boolean
  invokeCommand: (pluginKey: string, commandId: string, args: unknown) => Promise<unknown>
  invokeTaskSource: (
    pluginKey: string,
    sourceId: string,
    method: PluginTaskSourceMethod,
    params: unknown
  ) => Promise<unknown>
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown
  ) => Promise<PluginPanelActionOutcome>
  log: (pluginKey: string) => (level: 'info' | 'warn' | 'error', line: string) => void
  onStateChanged: (pluginKey: string) => void
  onWorkerGone: (pluginKey: string) => void
}

export class PluginWorkerController {
  private readonly manager: PluginWorkerManager
  private readonly activationErrors = new Map<string, string>()
  private readonly registeredSpecs = new Map<string, PluginWorkerSpawnSpec>()

  constructor(private readonly options: PluginWorkerControllerOptions) {
    this.manager = new PluginWorkerManager({
      entryPath: options.entryPath,
      maxActive: options.maxActive,
      idleReapMs: options.idleReapMs,
      workerFactory: options.workerFactory,
      executeHostCall: options.executeHostCall,
      log: options.log,
      onWorkerStateChange: options.onStateChanged,
      onWorkerGone: options.onWorkerGone
    })
  }

  state(pluginKey: string): { state: PluginRunState; restarts: number } {
    return {
      state: this.manager.runState(pluginKey),
      restarts: this.manager.restartCount(pluginKey)
    }
  }

  activationError(pluginKey: string): string | null {
    return this.activationErrors.get(pluginKey) ?? null
  }

  async ensure(plugin: ValidDiscoveredPlugin): Promise<PluginWorkerHandle> {
    if (!plugin.manifest.main) {
      throw new Error(`plugin ${plugin.pluginKey} has no worker entry`)
    }
    try {
      this.assertCurrentApproved(plugin)
      await this.options.contentVerifier.verify(plugin)
      await resolveContainedPluginArtifact(plugin.rootDir, plugin.manifest.main)
      this.assertCurrentApproved(plugin)
      const capabilities = this.options.capabilities(plugin.pluginKey)
      if (!capabilities) {
        throw new Error(`plugin ${plugin.pluginKey} is no longer approved`)
      }
      const spec = buildPluginWorkerSpawnSpec(plugin, capabilities)
      const handle = await this.manager.ensureActive(spec, () => this.assertCurrentApproved(plugin))
      if (!this.options.isCurrentApproved(plugin)) {
        await this.manager.deactivate(plugin.pluginKey)
        throw new Error(`plugin ${plugin.pluginKey} changed or was disabled during activation`)
      }
      const declaredCommands = new Set(
        plugin.manifest.contributes.commands
          .filter((command) => command.action === undefined)
          .map((command) => command.id)
      )
      const undeclaredCommand = handle.commands.find((command) => !declaredCommands.has(command))
      if (undeclaredCommand) {
        await this.manager.deactivate(plugin.pluginKey)
        throw new Error(
          `plugin ${plugin.pluginKey} registered undeclared command ${undeclaredCommand}`
        )
      }
      const declaredTaskSources = new Set(
        plugin.manifest.contributes.taskSources.map((source) => source.id)
      )
      const undeclaredTaskSource = handle.taskSources.find(
        (source) => !declaredTaskSources.has(source)
      )
      if (undeclaredTaskSource) {
        await this.manager.deactivate(plugin.pluginKey)
        throw new Error(
          `plugin ${plugin.pluginKey} registered undeclared task source ${undeclaredTaskSource}`
        )
      }
      this.activationErrors.delete(plugin.pluginKey)
      this.registerContributions(plugin, spec, handle)
      return handle
    } catch (error) {
      this.activationErrors.set(
        plugin.pluginKey,
        error instanceof Error ? error.message : String(error)
      )
      this.options.onStateChanged(plugin.pluginKey)
      throw error
    }
  }

  private assertCurrentApproved(plugin: ValidDiscoveredPlugin): void {
    if (!this.options.isCurrentApproved(plugin)) {
      throw new Error(`plugin ${plugin.pluginKey} changed or is no longer approved`)
    }
  }

  async reconcile(nextSpecs: ReadonlyMap<string, PluginWorkerSpawnSpec>): Promise<void> {
    const current = new Map([...this.registeredSpecs, ...this.manager.trackedSpecs()])
    for (const [pluginKey, spec] of current) {
      const next = nextSpecs.get(pluginKey)
      if (next && pluginWorkerSpawnSpecsEqual(spec, next)) {
        continue
      }
      this.options.registry.clearPlugin(pluginKey)
      this.registeredSpecs.delete(pluginKey)
      this.activationErrors.delete(pluginKey)
      await this.manager.deactivate(pluginKey)
    }
  }

  async deactivate(pluginKey: string): Promise<void> {
    this.options.registry.clearPlugin(pluginKey)
    this.registeredSpecs.delete(pluginKey)
    this.activationErrors.delete(pluginKey)
    await this.manager.deactivate(pluginKey)
  }

  reapIdle(): void {
    this.manager.reapIdle()
  }

  deliverEventIfRunning(pluginKey: string, event: PluginEventName, payload: unknown): void {
    this.manager.deliverEventIfRunning(pluginKey, event, payload)
  }

  dispose(): Promise<void> {
    return this.manager.disposeAll()
  }

  private registerContributions(
    plugin: ValidDiscoveredPlugin,
    spec: PluginWorkerSpawnSpec,
    handle: PluginWorkerHandle
  ): void {
    this.options.registry.clearPlugin(plugin.pluginKey)
    for (const commandId of handle.commands) {
      this.options.registry.register(
        PLUGIN_COMMAND_EXTENSION_POINT,
        plugin.pluginKey,
        {
          commandId,
          invoke: (args) => this.options.invokeCommand(plugin.pluginKey, commandId, args)
        },
        commandId
      )
    }
    for (const sourceId of handle.taskSources) {
      this.options.registry.register(
        PLUGIN_TASK_SOURCE_EXTENSION_POINT,
        plugin.pluginKey,
        {
          sourceId,
          // Never the raw worker value: the host owns validation and scrubbing
          // so no consumer of the extension point has to repeat them.
          call: (method, params) =>
            invokePluginTaskSourceMethod({
              callWorker: (request) =>
                this.options.invokeTaskSource(
                  request.pluginKey,
                  request.sourceId,
                  request.method,
                  request.params
                ),
              pluginKey: plugin.pluginKey,
              sourceId,
              method,
              params,
              resultSchema: PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[method]
            })
        },
        sourceId
      )
    }
    this.registeredSpecs.set(plugin.pluginKey, spec)
  }
}
