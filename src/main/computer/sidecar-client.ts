import { fork, type ChildProcess } from 'child_process'
import { join } from 'path'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
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

export function shouldUseComputerSidecar(): boolean {
  return (
    (process.platform === 'darwin' ||
      process.platform === 'linux' ||
      process.platform === 'win32') &&
    typeof process.versions.electron === 'string' &&
    process.env.ORCA_COMPUTER_SIDECAR !== '1'
  )
}

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
  return (await getComputerSidecar().call(method, params)) as ComputerActionResult
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
  private nextId = 1
  private pending = new Map<number, PendingRequest>()

  constructor(private readonly entryPath: string) {}

  call(method: ComputerSidecarMethod, params: unknown): Promise<unknown> {
    const child = this.ensureStarted()
    const id = this.nextId++
    const request: ComputerSidecarRequest = { id, method, params }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.shutdown()
        reject(new RuntimeClientError('action_timeout', `computer sidecar ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
      child.send?.(request, (error) => {
        if (!error) {
          return
        }
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RuntimeClientError('accessibility_error', error.message))
      })
    })
  }

  shutdown(): void {
    const child = this.child
    this.child = null
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

    const child = fork(this.entryPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_COMPUTER_SIDECAR: '1'
      },
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })

    child.on('message', (message) => this.handleMessage(message))
    child.on('exit', (code, signal) => this.handleExit(code, signal))
    child.on('error', (error) => this.handleError(error))
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

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
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

  private handleError(error: Error): void {
    const wrapped = new RuntimeClientError('accessibility_error', error.message)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(wrapped)
      this.pending.delete(id)
    }
  }
}

function isSidecarResponse(message: unknown): message is ComputerSidecarResponse {
  if (!message || typeof message !== 'object') {
    return false
  }
  const record = message as Record<string, unknown>
  return typeof record.id === 'number' && typeof record.ok === 'boolean'
}
