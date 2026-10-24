import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import {
  PLUGIN_COMMAND_EXTENSION_POINT,
  type PluginExtensionRegistry
} from '../../shared/plugins/plugin-extension-registry'
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
  isCurrentApproved: (spec: PluginWorkerSpawnSpec) => boolean
  invokeCommand: (pluginKey: string, commandId: string, args: unknown) => Promise<unknown>
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
  private reconcileGeneration = 0

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
      const capabilities = this.options.capabilities(plugin.pluginKey)
      if (!capabilities) {
        throw new Error(`plugin ${plugin.pluginKey} is no longer approved`)
      }
      const spec = buildPluginWorkerSpawnSpec(plugin, capabilities)
      this.assertCurrentApproved(spec)
      await resolveContainedPluginArtifact(plugin.rootDir, plugin.manifest.main)
      this.assertCurrentApproved(spec)
      // Why per spawn and uncached: an integrity check (not a sandbox) that bytes didn't change
      // between a crash and its restart; an already running worker is reused without hashing.
      const handle = await this.manager.ensureActive(spec, {
        assertApproved: () => this.assertCurrentApproved(spec),
        verifyBeforeSpawn: () =>
          this.options.contentVerifier.verifyNow({
            pluginKey: plugin.pluginKey,
            rootDir: plugin.rootDir,
            contentHash: spec.reviewedContentHash ?? null
          })
      })
      if (!this.options.isCurrentApproved(spec)) {
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
      this.activationErrors.delete(plugin.pluginKey)
      this.registerCommands(plugin, spec, handle.commands)
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

  private assertCurrentApproved(spec: PluginWorkerSpawnSpec): void {
    if (!this.options.isCurrentApproved(spec)) {
      throw new Error(`plugin ${spec.pluginKey} changed or is no longer approved`)
    }
  }

  /** Stops workers whose spec changed. With `resolveUpdated`, a worker that was running
   *  restarts on its new spec so an update doesn't leave it stopped until the next trigger. */
  async reconcile(
    nextSpecs: ReadonlyMap<string, PluginWorkerSpawnSpec>,
    resolveUpdated?: (pluginKey: string) => ValidDiscoveredPlugin | null
  ): Promise<void> {
    const generation = ++this.reconcileGeneration
    const running = this.manager.trackedSpecs()
    const current = new Map([...this.registeredSpecs, ...running])
    const restarts: ValidDiscoveredPlugin[] = []
    for (const [pluginKey, spec] of current) {
      const next = nextSpecs.get(pluginKey)
      if (next && pluginWorkerSpawnSpecsEqual(spec, next)) {
        continue
      }
      this.options.registry.clearPlugin(pluginKey)
      this.registeredSpecs.delete(pluginKey)
      this.activationErrors.delete(pluginKey)
      await this.manager.deactivate(pluginKey)
      const updated = next && running.has(pluginKey) ? resolveUpdated?.(pluginKey) : null
      if (updated) {
        restarts.push(updated)
      }
    }
    // Why after every stop and generation-checked: a newer reconcile or dispose owns the workers.
    if (generation !== this.reconcileGeneration) {
      return
    }
    await Promise.all(restarts.map((plugin) => this.ensure(plugin).catch(() => undefined)))
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
    this.reconcileGeneration += 1
    return this.manager.disposeAll()
  }

  private registerCommands(
    plugin: ValidDiscoveredPlugin,
    spec: PluginWorkerSpawnSpec,
    commands: readonly string[]
  ): void {
    this.options.registry.clearPlugin(plugin.pluginKey)
    for (const commandId of commands) {
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
    this.registeredSpecs.set(plugin.pluginKey, spec)
  }
}
