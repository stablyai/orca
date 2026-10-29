import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLUGIN_WORKER_INVOKE_TIMEOUT_MS,
  PLUGIN_WORKER_READY_TIMEOUT_MS,
  pluginWorkerChildMessageSchema,
  type PluginWorkerParentMessage
} from '../../shared/plugins/plugin-host-protocol'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { buildPluginWorkerEnv } from './plugin-worker-env'
import { pipePluginWorkerOutput } from './plugin-worker-output-buffer'

const PLUGIN_WORKER_SHUTDOWN_GRACE_MS = 2_000
const PLUGIN_WORKER_EVENT_TIMEOUT_MS = 5 * 60_000
const PLUGIN_WORKER_MAX_PENDING_EVENTS = 64

export type PluginWorkerLogSink = (level: 'info' | 'warn' | 'error', line: string) => void

export type PluginWorkerHostCallExecutor = (
  method: string,
  params: unknown
) => Promise<PluginPanelActionOutcome>

export type PluginWorkerHandle = {
  /** Command ids the worker registered on activate (⊆ manifest commands). */
  commands: readonly string[]
  invokeCommand(commandId: string, args?: unknown): Promise<unknown>
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

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export async function startPluginWorker(
  options: StartPluginWorkerOptions
): Promise<PluginWorkerHandle> {
  const { pluginId, rootDir, mainEntry, entryPath, log } = options
  const readyTimeoutMs = options.readyTimeoutMs ?? PLUGIN_WORKER_READY_TIMEOUT_MS
  const invokeTimeoutMs = options.invokeTimeoutMs ?? PLUGIN_WORKER_INVOKE_TIMEOUT_MS
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

  const pendingCommands = new Map<number, PendingCall>()
  const pendingEvents = new Map<number, ReturnType<typeof setTimeout>>()
  const exitCallbacks: ((code: number | null) => void)[] = []
  let nextCallId = 0
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
    for (const [callId, entry] of pendingCommands) {
      clearTimeout(entry.timer)
      pendingCommands.delete(callId)
      entry.reject(new Error(reason))
    }
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

  const commands = await new Promise<string[]>((resolve, reject) => {
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
            resolve(message.commands)
          }
          return
        }
        case 'commandResult': {
          const entry = pendingCommands.get(message.callId)
          if (!entry) {
            return
          }
          clearTimeout(entry.timer)
          pendingCommands.delete(message.callId)
          lastActivityAt = Date.now()
          if (message.ok) {
            entry.resolve(message.value)
          } else {
            entry.reject(new Error(message.error ?? 'plugin command failed'))
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

  return {
    commands,
    invokeCommand(commandId, args) {
      if (exited || disposed) {
        return Promise.reject(new Error(`${tag} worker is not running`))
      }
      const callId = nextCallId++
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCommands.delete(callId)
          reject(new Error(`${tag} ${commandId} timed out after ${invokeTimeoutMs}ms`))
        }, invokeTimeoutMs)
        pendingCommands.set(callId, { resolve, reject, timer })
        sendToChild({ type: 'invokeCommand', callId, commandId, args })
      })
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
    inFlightCount: () => pendingCommands.size + pendingEvents.size,
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
