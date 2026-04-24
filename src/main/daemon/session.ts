import { HeadlessEmulator } from './headless-emulator'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import type { SessionState, ShellReadyState, TerminalSnapshot } from './types'

const SHELL_READY_TIMEOUT_MS = 15_000
const KILL_TIMEOUT_MS = 5_000
const SHELL_READY_MARKER = '\x1b]777;orca-shell-ready\x07'

export type SubprocessHandle = {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  forceKill(): void
  signal(sig: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
}

export type SessionOptions = {
  sessionId: string
  cols: number
  rows: number
  subprocess: SubprocessHandle
  shellReadySupported: boolean
  scrollback?: number
}

type AttachedClient = {
  token: symbol
  onData: (data: string) => void
  onExit: (code: number) => void
}

export class Session {
  readonly sessionId: string
  private _state: SessionState = 'running'
  private _shellState: ShellReadyState
  private _exitCode: number | null = null
  private _isTerminating = false
  private _disposed = false
  private emulator: HeadlessEmulator
  private subprocess: SubprocessHandle
  private attachedClients: AttachedClient[] = []
  private preReadyStdinQueue: string[] = []
  private markerBuffer = ''
  private shellReadyTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.subprocess = opts.subprocess
    const size = normalizePtySize(opts.cols, opts.rows)
    this.emulator = new HeadlessEmulator({
      cols: size.cols,
      rows: size.rows,
      scrollback: opts.scrollback
      // No onData wiring: the daemon-side emulator must never reply to
      // terminal query sequences. The renderer's xterm is the authoritative
      // responder; any daemon reply races ahead via in-process parsing and
      // clobbers the renderer's answer. See the comment in HeadlessEmulator.
    })

    if (opts.shellReadySupported) {
      this._shellState = 'pending'
      this.shellReadyTimer = setTimeout(() => {
        this.onShellReadyTimeout()
      }, SHELL_READY_TIMEOUT_MS)
    } else {
      this._shellState = 'unsupported'
    }

    this.subprocess.onData((data) => this.handleSubprocessData(data))
    this.subprocess.onExit((code) => this.handleSubprocessExit(code))
  }

  get state(): SessionState {
    return this._state
  }

  get shellState(): ShellReadyState {
    return this._shellState
  }

  get exitCode(): number | null {
    return this._exitCode
  }

  get isAlive(): boolean {
    return this._state !== 'exited'
  }

  get isTerminating(): boolean {
    return this._isTerminating
  }

  get pid(): number {
    return this.subprocess.pid
  }

  write(data: string): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }

    if (this._shellState === 'pending') {
      this.preReadyStdinQueue.push(data)
      return
    }

    this.subprocess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    if (!isValidPtySize(cols, rows)) {
      return
    }
    this.emulator.resize(cols, rows)
    this.subprocess.resize(cols, rows)
  }

  kill(): void {
    if (this._state === 'exited' || this._isTerminating) {
      return
    }
    this._isTerminating = true

    this.subprocess.kill()

    this.killTimer = setTimeout(() => {
      if (this._state !== 'exited') {
        this.forceDispose()
      }
    }, KILL_TIMEOUT_MS)
  }

  signal(sig: string): void {
    if (this._state === 'exited') {
      return
    }
    this.subprocess.signal(sig)
  }

  attachClient(client: { onData: (data: string) => void; onExit: (code: number) => void }): symbol {
    const token = Symbol('attach')
    this.attachedClients.push({ token, ...client })
    return token
  }

  detachClient(token: symbol): void {
    const idx = this.attachedClients.findIndex((c) => c.token === token)
    if (idx !== -1) {
      this.attachedClients.splice(idx, 1)
    }
  }

  detachAllClients(): void {
    this.attachedClients.length = 0
  }

  getSnapshot(): TerminalSnapshot | null {
    if (this._disposed) {
      return null
    }
    return this.emulator.getSnapshot()
  }

  getCwd(): string | null {
    return this.emulator.getCwd()
  }

  clearScrollback(): void {
    if (this._disposed) {
      return
    }
    this.emulator.clearScrollback()
  }

  dispose(): void {
    if (this._disposed) {
      return
    }

    // Why: if kill() was called but the subprocess hasn't exited yet, our
    // killTimer is the only thing that would forceKill a stuck subprocess.
    // Clearing it below without force-killing would leak an orphaned process,
    // so mirror forceDispose(): issue the force-kill, notify attached clients
    // (handleSubprocessExit is guarded by _disposed and won't broadcast later),
    // and clear the terminating flag for a consistent final state.
    const wasTerminating = this._isTerminating && this._state !== 'exited'
    const clientsToNotify = wasTerminating ? this.attachedClients.slice() : []
    if (wasTerminating) {
      this.subprocess.forceKill()
      this._exitCode = -1
      this._isTerminating = false
    }

    this._disposed = true
    this._state = 'exited'

    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }

    this.attachedClients = []
    this.preReadyStdinQueue = []
    this.emulator.dispose()

    for (const client of clientsToNotify) {
      client.onExit(-1)
    }
  }

  private handleSubprocessData(data: string): void {
    if (this._disposed) {
      return
    }

    // Feed data to headless emulator for state tracking
    this.emulator.write(data)

    if (this._shellState === 'pending') {
      this.scanForShellMarker(data)
    }

    // Broadcast to attached clients
    for (const client of this.attachedClients) {
      client.onData(data)
    }
  }

  private handleSubprocessExit(code: number): void {
    if (this._disposed) {
      return
    }

    this._exitCode = code
    this._state = 'exited'

    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }

    for (const client of this.attachedClients) {
      client.onExit(code)
    }
  }

  private scanForShellMarker(data: string): void {
    this.markerBuffer += data

    const markerIdx = this.markerBuffer.indexOf(SHELL_READY_MARKER)
    if (markerIdx !== -1) {
      this.markerBuffer = ''
      this.transitionToReady()
      return
    }

    // Keep only the tail that could be the start of a partial marker match
    const maxPartial = SHELL_READY_MARKER.length - 1
    if (this.markerBuffer.length > maxPartial) {
      this.markerBuffer = this.markerBuffer.slice(-maxPartial)
    }
  }

  private transitionToReady(): void {
    this._shellState = 'ready'
    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
    this.flushPreReadyQueue()
  }

  private onShellReadyTimeout(): void {
    this.shellReadyTimer = null
    if (this._shellState !== 'pending') {
      return
    }
    this._shellState = 'timed_out'
    this.flushPreReadyQueue()
  }

  private flushPreReadyQueue(): void {
    const queued = this.preReadyStdinQueue
    this.preReadyStdinQueue = []
    for (const data of queued) {
      this.subprocess.write(data)
    }
  }

  private forceDispose(): void {
    if (this._state === 'exited') {
      return
    }
    this.subprocess.forceKill()
    this._disposed = true
    this._exitCode = -1
    this._state = 'exited'
    this._isTerminating = false

    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }

    const clients = this.attachedClients
    this.attachedClients = []
    this.preReadyStdinQueue = []
    this.emulator.dispose()

    for (const client of clients) {
      client.onExit(-1)
    }
  }
}
