import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import {
  startPluginWorker,
  type PluginWorkerHandle,
  type PluginWorkerHostCallExecutor,
  type PluginWorkerLogSink
} from './plugin-host-process'
import type { PluginWorkerSlotLease, PluginWorkerSlotPool } from './plugin-worker-slot-pool'

export type PluginWorkerSpawnSpec = {
  pluginKey: string
  rootDir: string
  mainEntry: string
  manifestRevision?: string
  /** Tree identity the user approved, so changed bytes count as a new revision. */
  reviewedContentHash?: string | null
  grantedCapabilities: readonly PluginCapabilityKind[]
}

/** A requested worker and the checks every spawn of it, including crash restarts, must pass. */
export type PluginWorkerAdmission = {
  spec: PluginWorkerSpawnSpec
  assertApproved: () => void
  verifyBeforeSpawn?: () => Promise<void>
}

export type PluginWorkerFactory = (options: {
  pluginId: string
  rootDir: string
  mainEntry: string
  entryPath: string
  grantedCapabilities: readonly PluginCapabilityKind[]
  executeHostCall: PluginWorkerHostCallExecutor
  log: PluginWorkerLogSink
  signal: AbortSignal
}) => Promise<PluginWorkerHandle>

export type StartedPluginWorker = {
  spec: PluginWorkerSpawnSpec
  generation: number
  handle: PluginWorkerHandle
  lease: PluginWorkerSlotLease
  completeStart(): { exited: boolean; code: number | null }
}

export async function startPluginWorkerAttempt(options: {
  spec: PluginWorkerSpawnSpec
  generation: number
  signal: AbortSignal
  slots: PluginWorkerSlotPool
  entryPath: string
  factory?: PluginWorkerFactory
  executeHostCall: PluginWorkerHostCallExecutor
  log: PluginWorkerLogSink
  assertActive: () => void
  verifyBeforeSpawn?: () => Promise<void>
  onExit: (worker: StartedPluginWorker, code: number | null) => void
}): Promise<StartedPluginWorker> {
  const lease = await options.slots.acquire(options.signal)
  let handle: PluginWorkerHandle | null = null
  let retained = false
  try {
    options.assertActive()
    if (options.verifyBeforeSpawn) {
      await untilAborted(options.verifyBeforeSpawn(), options.signal)
      options.assertActive()
    }
    const factory = options.factory ?? startPluginWorker
    handle = await factory({
      pluginId: options.spec.pluginKey,
      rootDir: options.spec.rootDir,
      mainEntry: options.spec.mainEntry,
      entryPath: options.entryPath,
      grantedCapabilities: options.spec.grantedCapabilities,
      executeHostCall: options.executeHostCall,
      log: options.log,
      signal: options.signal
    })
    options.assertActive()
    let startCompleted = false
    let earlyExit = false
    let earlyExitCode: number | null = null
    const worker: StartedPluginWorker = {
      spec: options.spec,
      generation: options.generation,
      handle,
      lease,
      completeStart: () => {
        startCompleted = true
        return { exited: earlyExit, code: earlyExitCode }
      }
    }
    handle.onExit((code) => {
      if (!startCompleted) {
        earlyExit = true
        earlyExitCode = code
        return
      }
      options.onExit(worker, code)
    })
    retained = true
    return worker
  } catch (error) {
    if (handle) {
      await handle.dispose().catch(() => undefined)
    }
    throw error
  } finally {
    if (!retained) {
      lease.release()
    }
  }
}

// Why: deactivation awaits the activation, so it must not also wait out a slow tree hash.
function untilAborted(task: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error('plugin worker activation was cancelled'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
