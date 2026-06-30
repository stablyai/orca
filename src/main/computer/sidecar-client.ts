import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
import { normalizeComputerActionResult } from './computer-action-verification-normalization'
import { validateComputerSidecarPasteText } from './computer-sidecar-paste-validation'
import { RuntimeClientError } from './runtime-client-error'

type ComputerSidecarMethod =
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
let sidecar: ComputerSidecarProcess | null = null

// Why: Node treats unhandled child 'error' events as process exceptions, so
// stale children keep a no-op listener that does not retain the sidecar owner.
function ignoreStaleChildError(): void {}

export async function callComputerSidecarListApps(): Promise<ComputerListAppsResult> {
  return (await getComputerSidecar().call('listApps', {})) as ComputerListAppsResult
}

export async function callComputerSidecarCapabilities(): Promise<ComputerProviderCapabilities> {
  return (await getComputerSidecar().call('capabilities', {})) as ComputerProviderCapabilities
}

export async function callComputerSidecarListWindows(
  params: unknown
): Promise<ComputerListWindowsResult> {
  return (await getComputerSidecar().call('listWindows', params)) as ComputerListWindowsResult
}

export async function callComputerSidecarSnapshot(
  params: unknown
): Promise<ComputerSnapshotResult> {
  return (await getComputerSidecar().call('getAppState', params)) as ComputerSnapshotResult
}

export async function callComputerSidecarAction(
  method: Exclude<
    ComputerSidecarMethod,
    'capabilities' | 'listApps' | 'listWindows' | 'getAppState'
  >,
  params: unknown
): Promise<ComputerActionResult> {
  const validation = validateComputerSidecarPasteText(method, params)
  if (validation) {
    await validation
  }
  return normalizeComputerActionResult(
    (await getComputerSidecar().call(method, params)) as ComputerActionResult
  )
}

export function resetComputerSidecarForTest(): void {
  sidecar?.shutdown()
  sidecar = null
}

function getComputerSidecar(): ComputerSidecarProcess {
  if (!sidecar) {
    sidecar = new ComputerSidecarProcess(getComputerSidecarEntryPath())
  }
  return sidecar
}

function getComputerSidecarEntryPath(): string {
  const app = loadElectronApp()
  const appPath = app?.getAppPath() ?? process.cwd()
  const isPackaged = app?.isPackaged ?? false
  // Why: packaged sidecars must be forked from app.asar.unpacked because
  // ELECTRON_RUN_AS_NODE bypasses Electron's asar require integration.
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

class ComputerSidecarProcess {
  private child: ChildProcess | null = null
  private childListenerCleanup: (() => void) | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private queueTail: Promise<void> | null = null
  private queueGeneration = 0

  constructor(private readonly entryPath: string) {}

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

  shutdown(): void {
    const child = this.child
    this.child = null
    this.queueGeneration++
    this.cleanupActiveChildListeners()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new RuntimeClientError('accessibility_error', 'computer sidecar shut down'))
      this.pending.delete(id)
    }
    child?.kill('SIGTERM')
  }

  private ensureStarted(): ChildProcess {
    if (this.child && !this.child.killed) {
      return this.child
    }
    this.cleanupActiveChildListeners()
    this.child = null

    const child = fork(this.entryPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_COMPUTER_SIDECAR: '1'
      },
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })

    const onMessage = (message: unknown) => {
      if (this.child === child) {
        this.handleMessage(message)
      }
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
    return child
  }

  private handleMessage(message: unknown): void {
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
    // Why: a timed-out child can exit after a replacement has started; stale
    // exits must not clear the live child or reject its in-flight requests.
    if (this.child !== child) {
      return
    }
    this.cleanupActiveChildListeners()
    this.child = null
    this.queueGeneration++
    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
    const error = new RuntimeClientError(
      'accessibility_error',
      `computer sidecar exited with ${detail}`
    )
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private handleError(child: ChildProcess, error: Error): void {
    // Why: late errors from a prior child should not poison the current sidecar.
    if (this.child !== child) {
      return
    }
    this.cleanupActiveChildListeners()
    // Why: an active process error makes the IPC sidecar unreliable; restart
    // on the next call instead of reusing a broken helper.
    this.failActiveChild(child, new RuntimeClientError('accessibility_error', error.message))
  }

  private failActiveChild(child: ChildProcess, error: RuntimeClientError): void {
    this.cleanupActiveChildListeners()
    this.child = null
    this.queueGeneration++
    child.kill('SIGTERM')
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
}

function isSidecarResponse(message: unknown): message is ComputerSidecarResponse {
  if (!message || typeof message !== 'object') {
    return false
  }
  const record = message as Record<string, unknown>
  return typeof record.id === 'number' && typeof record.ok === 'boolean'
}
