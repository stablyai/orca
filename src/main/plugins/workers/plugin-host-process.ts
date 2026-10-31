import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLUGIN_WORKER_INVOKE_TIMEOUT_MS,
  PLUGIN_WORKER_READY_TIMEOUT_MS,
  readPluginWorkerEvent,
  WORKER_EVENTS,
  WORKER_METHODS
} from '../../../shared/plugins/workers/plugin-host-protocol'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import type { PluginEventName } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_TASK_SOURCE_INVOKE_TIMEOUT_MS,
  type PluginTaskSourceOperation
} from '../../../shared/plugins/tasks/plugin-task-source'
import {
  pluginCancel,
  pluginEvent,
  pluginOutcomeResponse,
  pluginRequest,
  readPluginEnvelope,
  type PluginEnvelope,
  type PluginHostCallOutcome
} from '../../../shared/plugins/frames/plugin-protocol'
import { buildPluginWorkerEnv } from './plugin-worker-env'
import { pipePluginWorkerOutput } from './plugin-worker-output-buffer'
import { createPluginWorkerPendingCalls } from './plugin-worker-pending-calls'

const PLUGIN_WORKER_SHUTDOWN_GRACE_MS = 2_000
const PLUGIN_WORKER_EVENT_TIMEOUT_MS = 5 * 60_000
const PLUGIN_WORKER_MAX_PENDING_EVENTS = 64

export type PluginWorkerLogSink = (level: 'info' | 'warn' | 'error', line: string) => void

export type PluginWorkerHostCallExecutor = (
  method: string,
  params: unknown
) => Promise<PluginHostCallOutcome>

export type PluginWorkerHandle = {
  /** Command ids the worker registered on activate (⊆ manifest commands). */
  commands: readonly string[]
  invokeCommand(commandId: string, args?: unknown): Promise<unknown>
  /** Task source ids the worker registered on activate (⊆ manifest taskSources). */
  taskSources: readonly string[]
  /** Raw worker result; callers validate it against the operation's schema. */
  invokeTaskSource(
    sourceId: string,
    operation: PluginTaskSourceOperation,
    params: unknown
  ): Promise<unknown>
  deliverEvent(event: PluginEventName, payload: unknown): void
  /** Last completed work timestamp, in milliseconds, for idle reaping. */
  lastActivityAt(): number
  inFlightCount(): number
  dispose(): Promise<void>
  kill(): void
  onExit(callback: (code: number | null) => void): void
}

export type StartPluginWorkerOptions = {
  pluginId: string
  rootDir: string
  mainEntry: string
  /** Caller-resolved compiled entry path. */
  entryPath: string
  grantedCapabilities: readonly PluginCapabilityKind[]
  executeHostCall: PluginWorkerHostCallExecutor
  log: PluginWorkerLogSink
  readyTimeoutMs?: number
  invokeTimeoutMs?: number
  taskSourceTimeoutMs?: number
  eventTimeoutMs?: number
  signal?: AbortSignal
}

/** Fork the unpacked entry because Node cannot execute inside app.asar. */
export function resolvePluginHostEntryPath(appPath: string, isPackaged: boolean): string {
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'plugin-host-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'plugin-host-entry.js')
}

type WorkerRegistrations = { commands: string[]; taskSources: string[] }

export async function startPluginWorker(
  options: StartPluginWorkerOptions
): Promise<PluginWorkerHandle> {
  const { pluginId, rootDir, mainEntry, entryPath, log } = options
  const readyTimeoutMs = options.readyTimeoutMs ?? PLUGIN_WORKER_READY_TIMEOUT_MS
  const invokeTimeoutMs = options.invokeTimeoutMs ?? PLUGIN_WORKER_INVOKE_TIMEOUT_MS
  const taskSourceTimeoutMs = options.taskSourceTimeoutMs ?? PLUGIN_TASK_SOURCE_INVOKE_TIMEOUT_MS
  const eventTimeoutMs = options.eventTimeoutMs ?? PLUGIN_WORKER_EVENT_TIMEOUT_MS
  const tag = `[plugin:${pluginId}]`

  const child: ChildProcess = fork(entryPath, [], {
    // Scrub shell-exported secrets; ELECTRON_RUN_AS_NODE runs the Electron binary as Node.
    env: buildPluginWorkerEnv(),
    // Parent inspector/loader flags must not execute inside third-party workers.
    execArgv: [],
    // Default JSON serialization rejects supported structured-clone payloads (BigInt, cycles, maps).
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  pipePluginWorkerOutput(child.stdout, 'info', log)
  pipePluginWorkerOutput(child.stderr, 'error', log)

  const pendingCalls = createPluginWorkerPendingCalls(tag, (id) => sendToChild(pluginCancel(id)))
  const pendingEvents = new Map<number, ReturnType<typeof setTimeout>>()
  const exitCallbacks: ((code: number | null) => void)[] = []
  // One id space for host → worker requests: commands, task sources and events share `res`.
  let nextId = 0
  let exited = false
  let exitCode: number | null = null
  let disposed = false
  let lastActivityAt = Date.now()

  function sendToChild(message: PluginEnvelope): void {
    if (child.connected) {
      child.send(message)
    }
  }

  function rejectAllPending(reason: string): void {
    pendingCalls.rejectAll(reason)
    for (const timer of pendingEvents.values()) {
      clearTimeout(timer)
    }
    pendingEvents.clear()
  }

  child.on('exit', (code) => {
    exited = true
    exitCode = code
    rejectAllPending(`${tag} worker exited before responding`)
    for (const callback of exitCallbacks) {
      callback(code)
    }
  })
  child.on('disconnect', () => {
    // IPC may close while the worker remains alive; kill it to enter normal supervision.
    rejectAllPending(`${tag} worker disconnected before responding`)
    if (!exited) {
      child.kill('SIGKILL')
    }
  })

  const registered = await new Promise<WorkerRegistrations>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      fail(new Error(`${tag} worker did not become ready within ${readyTimeoutMs}ms`))
      child.kill('SIGKILL')
    }, readyTimeoutMs)
    function fail(error: Error): void {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    }
    const onAbort = (): void => {
      fail(new Error(`${tag} worker startup was cancelled`))
      child.kill('SIGKILL')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      const failure = new Error(`${tag} worker process error: ${error.message}`)
      fail(failure)
      child.kill('SIGKILL')
      // fail() stops acting after readiness; reject post-ready in-flight calls here too.
      rejectAllPending(failure.message)
    })
    child.on('exit', (code) => fail(new Error(`${tag} worker exited before ready (code ${code})`)))
    // A host call the worker cancels leaves this set, so its late answer is dropped.
    const inFlightHostCalls = new Set<number>()
    child.on('message', (raw) => {
      const message = readPluginEnvelope(raw)
      if (!message) {
        log('warn', 'ignoring malformed worker message')
        return
      }
      switch (message.kind) {
        case 'res': {
          lastActivityAt = Date.now()
          clearTimeout(pendingEvents.get(message.id))
          if (!pendingEvents.delete(message.id)) {
            pendingCalls.settle(message)
          }
          return
        }
        case 'req': {
          lastActivityAt = Date.now()
          const { id } = message
          inFlightHostCalls.add(id)
          void options.executeHostCall(message.method, message.params).then((outcome) => {
            lastActivityAt = Date.now()
            if (inFlightHostCalls.delete(id)) {
              sendToChild(pluginOutcomeResponse(id, outcome))
            }
          })
          return
        }
        case 'cancel':
          inFlightHostCalls.delete(message.id)
          return
        case 'evt':
          break
      }
      const event = readPluginWorkerEvent(message)
      if (event?.event === WORKER_EVENTS.ready && !settled) {
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve({ commands: event.payload.commands, taskSources: event.payload.taskSources })
      } else if (event?.event === WORKER_EVENTS.log) {
        log(event.payload.level, event.payload.message)
      } else if (event?.event === WORKER_EVENTS.fatal) {
        fail(new Error(`${tag} worker crashed: ${event.payload.error}`))
        rejectAllPending(`${tag} worker crashed: ${event.payload.error}`)
        child.kill('SIGKILL')
      }
    })
    sendToChild(
      pluginEvent(WORKER_EVENTS.init, {
        pluginId,
        pluginRoot: rootDir,
        mainEntry,
        grantedCapabilities: [...options.grantedCapabilities]
      })
    )
    if (options.signal?.aborted) {
      onAbort()
    }
  })

  function invokeWorker(
    label: string,
    timeoutMs: number,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (exited || disposed) {
      return Promise.reject(new Error(`${tag} worker is not running`))
    }
    const id = nextId++
    return pendingCalls.start(id, label, timeoutMs, () =>
      sendToChild(pluginRequest(id, method, params))
    )
  }

  return {
    commands: registered.commands,
    taskSources: registered.taskSources,
    invokeCommand(commandId, args) {
      return invokeWorker(commandId, invokeTimeoutMs, WORKER_METHODS.invokeCommand, {
        commandId,
        args
      })
    },
    invokeTaskSource(sourceId, operation, params) {
      return invokeWorker(
        `task source ${sourceId}.${operation}`,
        taskSourceTimeoutMs,
        WORKER_METHODS.invokeTaskSource,
        { sourceId, operation, params }
      )
    },
    deliverEvent(event, payload) {
      if (exited || disposed) {
        return
      }
      if (pendingEvents.size >= PLUGIN_WORKER_MAX_PENDING_EVENTS) {
        log('error', `${tag} exceeded the pending event limit`)
        child.kill('SIGKILL')
        return
      }
      lastActivityAt = Date.now()
      const eventId = nextId++
      const timer = setTimeout(() => {
        pendingEvents.delete(eventId)
        log('error', `${tag} ${event} did not finish within ${eventTimeoutMs}ms`)
        child.kill('SIGKILL')
      }, eventTimeoutMs)
      pendingEvents.set(eventId, timer)
      sendToChild(pluginRequest(eventId, WORKER_METHODS.deliverEvent, { event, payload }))
    },
    lastActivityAt: () => lastActivityAt,
    inFlightCount: () => pendingCalls.size() + pendingEvents.size,
    async dispose() {
      if (disposed) {
        return
      }
      disposed = true
      if (exited) {
        return
      }
      sendToChild(pluginEvent(WORKER_EVENTS.shutdown))
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL')
        }, PLUGIN_WORKER_SHUTDOWN_GRACE_MS)
        child.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        if (exited) {
          clearTimeout(killTimer)
          resolve()
        }
      })
    },
    kill() {
      child.kill('SIGKILL')
    },
    onExit(callback) {
      if (exited) {
        callback(exitCode)
      } else {
        exitCallbacks.push(callback)
      }
    }
  }
}
