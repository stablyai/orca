import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { ComputerProviderSupervisorHost } from './computer-provider-supervisor-host'
import type { ComputerProviderSupervisorMessage } from './computer-provider-supervisor-protocol'
import { RuntimeClientError } from './runtime-client-error'

export type ComputerSidecarMethod =
  | 'capabilities'
  | 'listApps'
  | 'listWindows'
  | 'getAppState'
  | 'click'
  | 'performSecondaryAction'
  | 'scroll'
  | 'drag'
  | 'typeText'
  | 'pressKey'
  | 'hotkey'
  | 'pasteText'
  | 'setValue'

type ComputerSidecarRequest = {
  id: number
  method: ComputerSidecarMethod
  params: unknown
}

type ComputerSidecarResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 60_000
export const COMPUTER_SIDECAR_FORCE_KILL_GRACE_MS = 5_000

// Why: stale children need an error listener without retaining their former owner.
function ignoreStaleChildError(): void {}

function terminateSidecarChild(child: ChildProcess): void {
  let exited = false
  let forceKillTimer: NodeJS.Timeout | null = null
  const onExit = (): void => {
    exited = true
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
  }
  child.once('exit', onExit)
  try {
    child.kill('SIGTERM')
  } catch {}
  if (exited) {
    return
  }
  forceKillTimer = setTimeout(() => {
    forceKillTimer = null
    child.off('exit', onExit)
    try {
      child.kill('SIGKILL')
    } catch {}
  }, COMPUTER_SIDECAR_FORCE_KILL_GRACE_MS)
  forceKillTimer.unref()
}

export class ComputerSidecarProcess {
  private child: ChildProcess | null = null
  private childListenerCleanup: (() => void) | null = null
  private readonly providerSupervisor = new ComputerProviderSupervisorHost()
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private queueTail: Promise<void> | null = null
  private queueGeneration = 0

  constructor(private readonly entryPath: string = getComputerSidecarEntryPath()) {}

  call(method: ComputerSidecarMethod, params: unknown): Promise<unknown> {
    const generation = this.queueGeneration
    const run = () => {
      if (generation !== this.queueGeneration) {
        throw new RuntimeClientError(
          'accessibility_error',
          'computer sidecar queue was invalidated; retry the computer-use request'
        )
      }
      return this.send(method, params)
    }
    const result = this.queueTail ? this.queueTail.then(run, run) : run()
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.queueTail = tail
    void tail.finally(() => {
      if (this.queueTail === tail) {
        this.queueTail = null
      }
    })
    return result
  }

  shutdown(): void {
    const child = this.child
    this.child = null
    this.queueGeneration++
    this.cleanupActiveChildListeners()
    this.providerSupervisor.shutdown()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new RuntimeClientError('accessibility_error', 'computer sidecar shut down'))
      this.pending.delete(id)
    }
    if (child) {
      terminateSidecarChild(child)
    }
  }

  private send(method: ComputerSidecarMethod, params: unknown): Promise<unknown> {
    const child = this.ensureStarted()
    if (!child.send) {
      const error = new RuntimeClientError(
        'accessibility_error',
        'computer sidecar IPC is unavailable'
      )
      this.failActiveChild(child, error)
      return Promise.reject(error)
    }
    const id = this.nextId++
    const request: ComputerSidecarRequest = { id, method, params }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.shutdown()
        reject(new RuntimeClientError('action_timeout', `computer sidecar ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
      child.send(request, (error) => {
        if (!error) {
          return
        }
        const wrapped = new RuntimeClientError('accessibility_error', error.message)
        if (this.child === child) {
          this.failActiveChild(child, wrapped)
          return
        }
        clearTimeout(timer)
        this.pending.delete(id)
        reject(wrapped)
      })
    })
  }

  private ensureStarted(): ChildProcess {
    if (this.child && !this.child.killed) {
      return this.child
    }
    this.cleanupActiveChildListeners()
    this.providerSupervisor.shutdown()
    this.child = null

    const child = fork(this.entryPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_COMPUTER_SIDECAR: '1'
      },
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })

    const onMessage = (message: unknown) => {
      if (this.child !== child || this.providerSupervisor.handle(message)) {
        return
      }
      this.handleResponse(message)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      this.handleExit(child, code, signal)
    const onError = (error: Error) => this.handleError(child, error)

    child.on('message', onMessage)
    child.on('exit', onExit)
    child.on('error', onError)
    this.childListenerCleanup = () => {
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', onError)
      child.off('error', ignoreStaleChildError)
      child.on('error', ignoreStaleChildError)
    }
    this.child = child
    this.providerSupervisor.attach((message) =>
      this.sendComputerProviderSupervisorMessage(child, message)
    )
    return child
  }

  private handleResponse(message: unknown): void {
    if (!isSidecarResponse(message)) {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok) {
      pending.resolve(message.result)
      return
    }
    pending.reject(new RuntimeClientError(message.error.code, message.error.message))
  }

  private handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child !== child) {
      return
    }
    this.cleanupActiveChildListeners()
    this.providerSupervisor.shutdown()
    this.child = null
    this.queueGeneration++
    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
    this.rejectPending(
      new RuntimeClientError('accessibility_error', `computer sidecar exited with ${detail}`)
    )
  }

  private handleError(child: ChildProcess, error: Error): void {
    if (this.child !== child) {
      return
    }
    this.cleanupActiveChildListeners()
    this.failActiveChild(child, new RuntimeClientError('accessibility_error', error.message))
  }

  private failActiveChild(child: ChildProcess, error: RuntimeClientError): void {
    this.cleanupActiveChildListeners()
    this.child = null
    this.queueGeneration++
    this.providerSupervisor.shutdown()
    terminateSidecarChild(child)
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private cleanupActiveChildListeners(): void {
    const cleanup = this.childListenerCleanup
    this.childListenerCleanup = null
    cleanup?.()
  }

  private sendComputerProviderSupervisorMessage(
    child: ChildProcess,
    message: ComputerProviderSupervisorMessage
  ): void {
    if (this.child !== child || !child.send) {
      return
    }
    try {
      child.send(message, (error) => {
        if (!error || this.child !== child) {
          return
        }
        this.failActiveChild(child, new RuntimeClientError('accessibility_error', error.message))
      })
    } catch (error) {
      if (this.child === child) {
        this.failActiveChild(
          child,
          new RuntimeClientError(
            'accessibility_error',
            error instanceof Error ? error.message : String(error)
          )
        )
      }
    }
  }
}

function getComputerSidecarEntryPath(): string {
  const app = loadElectronApp()
  const appPath = app?.getAppPath() ?? process.cwd()
  const isPackaged = app?.isPackaged ?? false
  // Why: ELECTRON_RUN_AS_NODE bypasses Electron's packaged asar require integration.
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  return join(basePath, 'out', 'main', 'computer-sidecar.js')
}

function loadElectronApp(): { getAppPath(): string; isPackaged: boolean } | null {
  try {
    return require('electron').app
  } catch {
    return null
  }
}

function isSidecarResponse(message: unknown): message is ComputerSidecarResponse {
  if (!message || typeof message !== 'object') {
    return false
  }
  const record = message as Record<string, unknown>
  return typeof record.id === 'number' && typeof record.ok === 'boolean'
}
