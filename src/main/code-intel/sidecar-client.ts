import { fork, type ChildProcess } from 'child_process'
import { join } from 'path'
import type { CodeIntelRequest, CodeIntelResult } from '../../shared/code-intel-contract'
import { isSidecarResponse, type SidecarMethod, type SidecarRequest } from './sidecar-protocol'

const REQUEST_TIMEOUT_MS = 30_000

type Pending = {
  resolve: (result: CodeIntelResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type ForkFn = (entryPath: string) => ChildProcess

let singleton: CodeIntelSidecarClient | null = null

export function getCodeIntelSidecar(): CodeIntelSidecarClient {
  if (!singleton) {
    singleton = new CodeIntelSidecarClient(getEntryPath())
  }
  return singleton
}

export function resetCodeIntelSidecarForTest(): void {
  singleton?.shutdown()
  singleton = null
}

export function shutdownCodeIntelSidecar(): void {
  singleton?.shutdown()
  singleton = null
}

function getEntryPath(): string {
  const app = loadElectronApp()
  const appPath = app?.getAppPath() ?? process.cwd()
  const isPackaged = app?.isPackaged ?? false
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  return join(basePath, 'out', 'main', 'code-intel-sidecar.js')
}

function loadElectronApp(): { getAppPath(): string; isPackaged: boolean } | null {
  try {
    return require('electron').app
  } catch {
    return null
  }
}

const defaultFork: ForkFn = (entryPath) =>
  fork(entryPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_CODE_INTEL_SIDECAR: '1' },
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  })

export class CodeIntelSidecarClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly entryPath: string,
    private readonly forkFn: ForkFn = defaultFork
  ) {}

  query(
    method: SidecarMethod,
    params: CodeIntelRequest,
    signal?: AbortSignal
  ): Promise<CodeIntelResult> {
    const child = this.ensureStarted()
    const id = this.nextId++
    const request: SidecarRequest = { id, kind: 'query', method, params }
    return new Promise<CodeIntelResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`code-intel sidecar ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })

      if (signal) {
        const onAbort = (): void => {
          child.send?.({ id, kind: 'cancel' } satisfies SidecarRequest)
          const entry = this.pending.get(id)
          if (entry) {
            clearTimeout(entry.timer)
            this.pending.delete(id)
            entry.reject(new Error('cancelled'))
          }
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      child.send?.(request, (error) => {
        if (!error) {
          return
        }
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  shutdown(): void {
    const child = this.child
    this.child = null
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('code-intel sidecar shut down'))
      this.pending.delete(id)
    }
    child?.kill('SIGTERM')
  }

  private ensureStarted(): ChildProcess {
    if (this.child && !this.child.killed) {
      return this.child
    }
    const child = this.forkFn(this.entryPath)
    child.on('message', (message) => this.handleMessage(message))
    child.on('exit', (code, signal) => this.handleExit(child, code, signal))
    child.on('error', (error) => this.handleError(child, error))
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
    pending.reject(new Error(message.error.message))
  }

  private handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child !== child) {
      return
    }
    this.child = null
    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
    const error = new Error(`code-intel sidecar exited with ${detail}`)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private handleError(child: ChildProcess, error: Error): void {
    if (this.child !== child) {
      return
    }
    // Why: an 'error' event without a following 'exit' would otherwise leave a
    // dead child referenced here, and ensureStarted() would reuse it (its
    // `.killed` flag may be unset). Drop it so the next query forks a fresh one.
    this.child = null
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
