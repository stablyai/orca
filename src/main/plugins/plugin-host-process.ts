import { fork, type ChildProcess } from 'node:child_process'
import {
  PLUGIN_WORKER_INVOKE_TIMEOUT_MS,
  PLUGIN_WORKER_READY_TIMEOUT_MS,
  pluginWorkerChildMessageSchema,
  type PluginWorkerParentMessage
} from '../../shared/plugins/plugin-host-protocol'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import {
  PLUGIN_TASK_SOURCE_INVOKE_TIMEOUT_MS,
  type PluginTaskSourceOperation
} from '../../shared/plugins/plugin-task-source'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { buildPluginWorkerEnv } from './plugin-worker-env'
import { pipePluginWorkerOutput } from './plugin-worker-output-buffer'
import { createPluginWorkerPendingCalls } from './plugin-worker-pending-calls'

// Grace between the shutdown message and SIGKILL: long enough for plugin
// cleanup, short enough that disable/quit never feels stuck.
const PLUGIN_WORKER_SHUTDOWN_GRACE_MS = 2_000
const PLUGIN_WORKER_EVENT_TIMEOUT_MS = 5 * 60_000
const PLUGIN_WORKER_MAX_PENDING_EVENTS = 64

export type PluginWorkerLogSink = (level: 'info' | 'warn' | 'error', line: string) => void

/** Executes a worker-originated host API call; the outcome is relayed back
 *  over the fork channel as a hostResult message. */
export type PluginWorkerHostCallExecutor = (
  method: string,
  params: unknown
) => Promise<PluginPanelActionOutcome>

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
  /** Milliseconds timestamp of the last completed work (for idle reap). */
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
  /** Absolute path to the compiled plugin-host-entry.js, resolved by caller. */
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
    // Why: ELECTRON_RUN_AS_NODE makes the forked Electron binary behave as
    // plain Node. The env is a scrubbed allowlist — never ...process.env,
    // which can carry shell-exported secrets into third-party code.
    env: buildPluginWorkerEnv(),
    // Why: inspector/loader flags from Orca's own launch must never execute
    // inside third-party plugin workers.
    execArgv: [],
    // Why: the protocol permits structured-clone values. Node's default JSON
    // fork serialization rejects BigInt, cycles, maps, and typed arrays.
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  pipePluginWorkerOutput(child.stdout, 'info', log)
  pipePluginWorkerOutput(child.stderr, 'error', log)

  const pendingCalls = createPluginWorkerPendingCalls(tag)
  const pendingEvents = new Map<number, ReturnType<typeof setTimeout>>()
  const exitCallbacks: ((code: number | null) => void)[] = []
  let nextEventId = 0
  let exited = false
  let exitCode: number | null = null
  let disposed = false
  let lastActivityAt = Date.now()

  function sendToChild(message: PluginWorkerParentMessage): void {
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
    // Why: a worker can drop fork IPC while its event loop stays alive. Kill
    // it so the ensuing exit enters the normal supervision/backoff path.
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
      // Why: fail() no-ops once ready; a post-ready channel fault must still
      // reject in-flight calls instead of letting each hit its own timeout.
      rejectAllPending(failure.message)
    })
    child.on('exit', (code) => fail(new Error(`${tag} worker exited before ready (code ${code})`)))
    child.on('message', (raw) => {
      const parsed = pluginWorkerChildMessageSchema.safeParse(raw)
      if (!parsed.success) {
        log('warn', 'ignoring malformed worker message')
        return
      }
      const message = parsed.data
      switch (message.type) {
        case 'ready': {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
            resolve({ commands: message.commands, taskSources: message.taskSources })
          }
          return
        }
        case 'commandResult':
        case 'taskSourceResult': {
          const error = message.error ?? `plugin ${message.type} failed`
          const outcome = message.ok
            ? { ok: true as const, value: message.value }
            : { ok: false as const, error }
          if (pendingCalls.settle(message.callId, outcome)) {
            lastActivityAt = Date.now()
          }
          return
        }
        case 'eventAck': {
          const timer = pendingEvents.get(message.eventId)
          if (timer) {
            clearTimeout(timer)
            pendingEvents.delete(message.eventId)
          }
          lastActivityAt = Date.now()
          return
        }
        case 'hostCall': {
          lastActivityAt = Date.now()
          // Host API calls from the worker: gate + execute in main, then
          // relay the outcome. Never throws — errors become outcomes.
          void options.executeHostCall(message.method, message.params).then((outcome) => {
            lastActivityAt = Date.now()
            sendToChild(
              outcome.ok
                ? { type: 'hostResult', callId: message.callId, ok: true, value: outcome.value }
                : {
                    type: 'hostResult',
                    callId: message.callId,
                    ok: false,
                    errorCode: outcome.code,
                    error: outcome.error
                  }
            )
          })
          return
        }
        case 'log': {
          log(message.level, message.message)
          return
        }
        case 'fatal': {
          fail(new Error(`${tag} worker crashed: ${message.error}`))
          rejectAllPending(`${tag} worker crashed: ${message.error}`)
          child.kill('SIGKILL')
        }
      }
    })
    sendToChild({
      type: 'init',
      pluginId,
      pluginRoot: rootDir,
      mainEntry,
      grantedCapabilities: [...options.grantedCapabilities]
    })
    if (options.signal?.aborted) {
      onAbort()
    }
  })

  function invokeWorker(
    label: string,
    timeoutMs: number,
    message: (callId: number) => PluginWorkerParentMessage
  ): Promise<unknown> {
    if (exited || disposed) {
      return Promise.reject(new Error(`${tag} worker is not running`))
    }
    return pendingCalls.start(label, timeoutMs, (callId) => sendToChild(message(callId)))
  }

  return {
    commands: registered.commands,
    taskSources: registered.taskSources,
    invokeCommand(commandId, args) {
      return invokeWorker(commandId, invokeTimeoutMs, (callId) => ({
        type: 'invokeCommand',
        callId,
        commandId,
        args
      }))
    },
    invokeTaskSource(sourceId, operation, params) {
      const label = `task source ${sourceId}.${operation}`
      return invokeWorker(label, taskSourceTimeoutMs, (callId) => ({
        type: 'invokeTaskSource',
        callId,
        sourceId,
        operation,
        params
      }))
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
      const eventId = nextEventId++
      const timer = setTimeout(() => {
        pendingEvents.delete(eventId)
        log('error', `${tag} ${event} did not finish within ${eventTimeoutMs}ms`)
        child.kill('SIGKILL')
      }, eventTimeoutMs)
      pendingEvents.set(eventId, timer)
      sendToChild({ type: 'deliverEvent', eventId, event, payload })
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
      sendToChild({ type: 'shutdown' })
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
