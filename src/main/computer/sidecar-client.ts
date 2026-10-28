import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
import { normalizeComputerActionResult } from './computer-action-verification-normalization'
import { isComputerSidecarDiagnostic, logComputerDiagnostic } from './computer-sidecar-diagnostics'
import { validateComputerSidecarPasteText } from './computer-sidecar-paste-validation'
import { RuntimeClientError } from './runtime-client-error'
import { getForkedChildEntryPath } from '../forked-child-entry-path'

// Bundled beside orcad.js on servers and under out/main on desktop.
export const COMPUTER_SIDECAR_ENTRY_FILENAME = 'computer-sidecar.js'

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

// Suppress stale child errors without retaining the owner or crashing the process.
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
    sidecar = new ComputerSidecarProcess(getForkedChildEntryPath(COMPUTER_SIDECAR_ENTRY_FILENAME))
  }
  return sidecar
}

export function computerSidecarMissingMessage(entryPath: string): string {
  return `Computer use isn't available on this host: its Orca install has no computer-use sidecar (${entryPath}). On an Orca server installed before computer use shipped with it, update or reprovision the server.`
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
    // Report the missing entry path before fork reduces it to an opaque exit code.
    if (!existsSync(this.entryPath)) {
      throw new RuntimeClientError(
        'unsupported_capability',
        computerSidecarMissingMessage(this.entryPath)
      )
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
    if (isComputerSidecarDiagnostic(message)) {
      logComputerDiagnostic(message.message)
      return
    }
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
    // Ignore stale exits so they cannot reject the replacement's requests.
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
    // Ignore late errors from a replaced sidecar.
    if (this.child !== child) {
      return
    }
    this.cleanupActiveChildListeners()
    // Restart on the next request after an active transport failure.
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
