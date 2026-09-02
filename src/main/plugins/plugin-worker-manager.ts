import {
  PLUGIN_WORKER_IDLE_REAP_MS,
  PLUGIN_WORKER_MAX_ACTIVE_DEFAULT
} from '../../shared/plugins/plugin-host-protocol'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import {
  PluginSupervisor,
  type PluginRestartDecision,
  type PluginRunState
} from './plugin-supervisor'
import type { PluginWorkerHandle, PluginWorkerHostCallExecutor } from './plugin-host-process'
import { PluginWorkerSlotPool } from './plugin-worker-slot-pool'
import {
  startPluginWorkerAttempt,
  type PluginWorkerFactory,
  type PluginWorkerSpawnSpec,
  type StartedPluginWorker
} from './plugin-worker-startup'
import { runPluginWorkerRestartLoop } from './plugin-worker-restart-loop'
import { pluginWorkerSpawnSpecsEqual } from './plugin-worker-spawn-spec'

export type { PluginWorkerFactory, PluginWorkerSpawnSpec } from './plugin-worker-startup'

export type PluginWorkerManagerOptions = {
  entryPath: string
  maxActive?: number
  idleReapMs?: number
  workerFactory?: PluginWorkerFactory
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown
  ) => ReturnType<PluginWorkerHostCallExecutor>
  log: (pluginKey: string, level: 'info' | 'warn' | 'error', line: string) => void
  onWorkerStateChange: (pluginKey: string) => void
  onWorkerGone: (pluginKey: string) => void
}

type ActivationRecord = {
  spec: PluginWorkerSpawnSpec
  generation: number
  controller: AbortController
  task: Promise<PluginWorkerHandle>
}

/** Owns lazy activation, bounded capacity, restart policy, cancellation, and idle reap. */
export class PluginWorkerManager {
  private readonly supervisor = new PluginSupervisor()
  private readonly workers = new Map<string, StartedPluginWorker>()
  private readonly activations = new Map<string, ActivationRecord>()
  private readonly knownSpecs = new Map<string, PluginWorkerSpawnSpec>()
  private readonly generations = new Map<string, number>()
  private readonly stoppingWorkers = new Set<Promise<void>>()
  private readonly slots: PluginWorkerSlotPool
  private readonly idleReapMs: number
  private disposed = false

  constructor(private readonly options: PluginWorkerManagerOptions) {
    this.slots = new PluginWorkerSlotPool(options.maxActive ?? PLUGIN_WORKER_MAX_ACTIVE_DEFAULT)
    this.idleReapMs = options.idleReapMs ?? PLUGIN_WORKER_IDLE_REAP_MS
  }

  runState(pluginKey: string): PluginRunState {
    return this.supervisor.getState(pluginKey)
  }

  restartCount(pluginKey: string): number {
    return this.supervisor.restartCount(pluginKey)
  }

  trackedSpecs(): ReadonlyMap<string, PluginWorkerSpawnSpec> {
    return new Map(this.knownSpecs)
  }

  async ensureActive(spec: PluginWorkerSpawnSpec): Promise<PluginWorkerHandle> {
    if (this.disposed) {
      throw new Error('plugin workers are shut down')
    }
    if (this.supervisor.getState(spec.pluginKey) === 'errored') {
      throw new Error(`plugin ${spec.pluginKey} is errored after repeated failures`)
    }
    for (;;) {
      const existing = this.workers.get(spec.pluginKey)
      const pending = this.activations.get(spec.pluginKey)
      const activeSpec = existing?.spec ?? pending?.spec
      if (!activeSpec) {
        break
      }
      if (pluginWorkerSpawnSpecsEqual(activeSpec, spec)) {
        return existing?.handle ?? pending!.task
      }
      // Why: refresh/trigger races can present a new dev manifest while the
      // old revision is still starting. Cancel and re-check atomically enough
      // that callers never join a stale activation by key alone.
      await this.deactivate(spec.pluginKey)
      if (this.disposed) {
        throw new Error('plugin workers are shut down')
      }
    }
    const generation = this.nextGeneration(spec.pluginKey)
    this.knownSpecs.set(spec.pluginKey, spec)
    this.supervisor.markRunning(spec.pluginKey, { resetRestarts: true })
    return this.beginActivation(spec, generation)
  }

  private beginActivation(
    spec: PluginWorkerSpawnSpec,
    generation: number,
    firstRestart?: Extract<PluginRestartDecision, { restart: true }>
  ): Promise<PluginWorkerHandle> {
    const controller = new AbortController()
    const task = this.activate(spec, generation, controller.signal, firstRestart)
    const record: ActivationRecord = { spec, generation, controller, task }
    this.activations.set(spec.pluginKey, record)
    void task.then(
      () => this.finishActivation(spec.pluginKey, record),
      () => this.finishActivation(spec.pluginKey, record)
    )
    return task
  }

  private finishActivation(pluginKey: string, record: ActivationRecord): void {
    if (this.activations.get(pluginKey) === record) {
      this.activations.delete(pluginKey)
    }
  }

  private async activate(
    spec: PluginWorkerSpawnSpec,
    generation: number,
    signal: AbortSignal,
    firstRestart?: Extract<PluginRestartDecision, { restart: true }>
  ): Promise<PluginWorkerHandle> {
    return runPluginWorkerRestartLoop({
      signal,
      firstRestart,
      assertActive: () => this.throwIfCancelled(spec.pluginKey, generation, signal),
      start: async () => {
        const worker = await startPluginWorkerAttempt({
          spec,
          generation,
          signal,
          slots: this.slots,
          entryPath: this.options.entryPath,
          factory: this.options.workerFactory,
          executeHostCall: (method, params) =>
            this.options.executeHostCall(spec.pluginKey, method, params),
          log: (level, line) => this.options.log(spec.pluginKey, level, line),
          assertActive: () => this.throwIfCancelled(spec.pluginKey, generation, signal),
          onExit: (record, code) => this.handleUnexpectedExit(spec.pluginKey, record, code)
        })
        this.workers.set(spec.pluginKey, worker)
        const earlyExit = worker.completeStart()
        if (earlyExit.exited) {
          this.detachWorker(spec.pluginKey, worker)
          throw new Error(`worker exited immediately after ready (code ${earlyExit.code})`)
        }
        this.supervisor.markRunning(spec.pluginKey)
        this.options.onWorkerStateChange(spec.pluginKey)
        return worker.handle
      },
      recordFailure: (error) => this.recordFailure(spec.pluginKey, 'worker failed to start', error),
      erroredError: (error) =>
        new Error(
          `plugin ${spec.pluginKey} is errored after repeated failures: ${this.errorText(error)}`
        )
    })
  }

  private handleUnexpectedExit(
    pluginKey: string,
    record: StartedPluginWorker,
    code: number | null
  ): void {
    if (!this.detachWorker(pluginKey, record)) {
      return
    }
    if (this.isCancelled(pluginKey, record.generation)) {
      return
    }
    const decision = this.recordFailure(pluginKey, `worker exited unexpectedly (code ${code})`)
    if (decision.restart) {
      this.beginActivation(record.spec, record.generation, decision)
    }
  }

  private recordFailure(
    pluginKey: string,
    context: string,
    error?: unknown
  ): PluginRestartDecision {
    this.options.onWorkerGone(pluginKey)
    const decision = this.supervisor.markExited(pluginKey, { crashed: true })
    this.options.onWorkerStateChange(pluginKey)
    if (decision.restart) {
      this.options.log(
        pluginKey,
        'warn',
        `${context}${error ? `: ${this.errorText(error)}` : ''}; restart ${decision.attempt} in ${decision.delayMs}ms`
      )
    } else if (decision.state === 'errored') {
      this.options.log(pluginKey, 'error', `${context}; marked errored after repeated failures`)
    }
    return decision
  }

  private detachWorker(pluginKey: string, record: StartedPluginWorker): boolean {
    if (this.workers.get(pluginKey) !== record) {
      return false
    }
    this.workers.delete(pluginKey)
    record.lease.release()
    return true
  }

  deliverEventIfRunning(pluginKey: string, event: PluginEventName, payload: unknown): void {
    this.workers.get(pluginKey)?.handle.deliverEvent(event, payload)
  }

  async deactivate(pluginKey: string): Promise<void> {
    this.nextGeneration(pluginKey)
    const activation = this.activations.get(pluginKey)
    activation?.controller.abort()
    const record = this.workers.get(pluginKey)
    if (record) {
      this.workers.delete(pluginKey)
    }
    this.options.onWorkerGone(pluginKey)
    this.supervisor.reset(pluginKey)
    this.knownSpecs.delete(pluginKey)
    await Promise.all([
      activation?.task.catch(() => undefined),
      record?.handle.dispose().catch(() => undefined)
    ])
    record?.lease.release()
  }

  reapIdle(now = Date.now()): void {
    for (const [pluginKey, record] of this.workers) {
      if (
        record.handle.inFlightCount() !== 0 ||
        now - record.handle.lastActivityAt() <= this.idleReapMs
      ) {
        continue
      }
      this.nextGeneration(pluginKey)
      this.knownSpecs.delete(pluginKey)
      this.workers.delete(pluginKey)
      this.options.onWorkerGone(pluginKey)
      this.supervisor.markExited(pluginKey, { crashed: false })
      this.options.log(pluginKey, 'info', 'worker reaped after idle period')
      this.options.onWorkerStateChange(pluginKey)
      const stopping = record.handle
        .dispose()
        .catch(() => undefined)
        .finally(() => record.lease.release())
      this.stoppingWorkers.add(stopping)
      void stopping.then(() => this.stoppingWorkers.delete(stopping))
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    const pluginKeys = new Set([...this.activations.keys(), ...this.workers.keys()])
    for (const key of pluginKeys) {
      this.nextGeneration(key)
      this.options.onWorkerGone(key)
    }
    const activations = [...this.activations.values()]
    for (const activation of activations) {
      activation.controller.abort()
    }
    this.slots.dispose()
    const workers = [...this.workers.values()]
    this.workers.clear()
    this.knownSpecs.clear()
    const stoppingWorkers = [...this.stoppingWorkers]
    await Promise.all([
      ...stoppingWorkers,
      ...activations.map((activation) => activation.task.catch(() => undefined)),
      ...workers.map(async (record) => {
        await record.handle.dispose().catch(() => undefined)
        record.lease.release()
      })
    ])
  }

  private nextGeneration(pluginKey: string): number {
    const generation = (this.generations.get(pluginKey) ?? 0) + 1
    this.generations.set(pluginKey, generation)
    return generation
  }

  private isCancelled(pluginKey: string, generation: number, signal?: AbortSignal): boolean {
    return (
      this.disposed || signal?.aborted === true || this.generations.get(pluginKey) !== generation
    )
  }

  private throwIfCancelled(pluginKey: string, generation: number, signal: AbortSignal): void {
    if (this.isCancelled(pluginKey, generation, signal)) {
      throw new Error('plugin worker activation was cancelled')
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
