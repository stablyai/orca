import { spawnProcess, type ChildProcessHandle } from '../../shared/child-process/run-process'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '../../shared/child-process/process-tree-termination'
import type { OmpRpcSpawnOptions } from '../../shared/omp-rpc-protocol'
import {
  captureWindowsDescendantSnapshot,
  terminateIdentifiedWindowsProcessTree,
  verifyWindowsDescendantSnapshotExit
} from '../windows-descendant-exit-verification'
import { OMP_RPC_MAX_FRAME_BYTES } from './omp-rpc-transport-limits'

const STDERR_TAIL_BYTES = 8_192
const FORCE_KILL_DELAY_MS = 2_000

type WindowsTerminationResult = 'verified-tree' | 'unverified'

export type OmpRpcProcessTransportHandlers = {
  onLine: (line: string) => void
  /** A stdout line grew past the protocol's single-frame cap without a
   *  newline; the transport has stopped reading and the session is lost. */
  onLineOverflow: (message: string) => void
  onInvalidUtf8: (message: string) => void
  onStreamError: (error: Error) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null, cause?: Error) => void
}

export class OmpRpcProcessTransport {
  private readonly child: ChildProcessHandle
  /** A strict streaming decoder preserves split UTF-8 scalars but rejects a
   *  malformed byte sequence before JSON can reinterpret the protocol frame. */
  private readonly stdoutDecoder = new TextDecoder('utf-8', { fatal: true })
  private stdoutBuffer = ''
  /** Our default until the ready frame advertises the server's own cap. */
  private maxLineBytes = OMP_RPC_MAX_FRAME_BYTES
  private stderrBytes = Buffer.alloc(0)
  private childError: Error | undefined
  private hasExited = false
  private isDisposed = false
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDisposedExit:
    | { code: number | null; signal: NodeJS.Signals | null; cause?: Error }
    | undefined
  private windowsProcessTreeTermination: Promise<WindowsTerminationResult> | null = null
  private windowsProcessTreeExitUnverified = false
  private windowsForceTerminationRequested = false
  private processTreeTerminationInFlight = false
  private processTreeTerminationVerified = false

  constructor(
    options: OmpRpcSpawnOptions,
    private readonly handlers: OmpRpcProcessTransportHandlers
  ) {
    if (
      options.sessionMode === 'session-owning' &&
      [...(options.commandArgs ?? []), ...(options.extraArgs ?? [])].some(
        (arg) => arg === '--no-session' || arg.startsWith('--no-session=')
      )
    ) {
      throw new Error('session-owning OMP RPC spawn cannot include --no-session')
    }
    this.child = spawnProcess({
      program: options.executablePath,
      args: [
        ...(options.commandArgs ?? []),
        '--mode',
        'rpc',
        ...(options.sessionMode === 'session-owning' ? [] : ['--no-session']),
        ...(options.extraArgs ?? [])
      ],
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The dedicated POSIX group is the only safe blast radius for OMP's
      // tool/subagent descendants during ownership teardown.
      detached: process.platform !== 'win32'
    })
    this.child.stdout?.on('data', this.handleStdout)
    this.child.stderr?.on('data', this.handleStderr)
    this.child.on('error', this.handleChildError)
    this.child.on('close', this.handleChildClose)
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.on('error', this.handlers.onStreamError)
    }
  }

  get stderrTail(): string {
    return this.stderrBytes.toString('utf8')
  }

  write(frame: unknown): boolean {
    if (this.isDisposed || this.hasExited || !this.child.stdin) {
      return false
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
    return true
  }

  dispose(): void {
    if (this.isDisposed || this.hasExited) {
      return
    }
    this.isDisposed = true
    this.child.stdin?.end()
    this.terminateChild('SIGTERM')
    this.child.stdout?.removeListener('data', this.handleStdout)
    this.forceKillTimer = setTimeout(() => {
      this.forceTerminateChildTree()
    }, FORCE_KILL_DELAY_MS)
    this.forceKillTimer.unref?.()
  }

  /** Adopt the server's advertised single-frame cap (ready frame); the
   *  default is only a guard for the window before it is known. */
  setMaxLineBytes(maxLineBytes: number): void {
    this.maxLineBytes = maxLineBytes
  }

  private readonly handleStdout = (chunk: Buffer | string): void => {
    try {
      this.stdoutBuffer += this.stdoutDecoder.decode(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        { stream: true }
      )
    } catch {
      this.stdoutBuffer = ''
      this.child.stdout?.removeListener('data', this.handleStdout)
      this.handlers.onInvalidUtf8('OMP RPC stdout contained invalid UTF-8')
      return
    }
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex)
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.stdoutBuffer = ''
        this.child.stdout?.removeListener('data', this.handleStdout)
        this.handlers.onLineOverflow(`OMP RPC stdout line exceeded ${this.maxLineBytes} bytes`)
        return
      }
      this.handlers.onLine(line)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
    // Why: a single JSONL frame is capped at the server's advertised frame size;
    // a child that stops emitting newlines must not grow main-process memory
    // without bound. Chars under-count bytes, so this is the lenient side.
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxLineBytes) {
      this.stdoutBuffer = ''
      this.child.stdout?.removeListener('data', this.handleStdout)
      this.handlers.onLineOverflow(
        `OMP RPC stdout line exceeded ${this.maxLineBytes} bytes without a newline`
      )
    }
  }

  private terminateChild(signal: NodeJS.Signals): void {
    if (process.platform === 'win32' && this.child.pid) {
      if (this.windowsProcessTreeTermination) {
        return
      }
      const termination = this.terminateWindowsChildTree(signal).then((result) => {
        const unverified = result === 'unverified'
        if (!unverified && this.windowsProcessTreeTermination === termination) {
          this.windowsProcessTreeTermination = null
          this.windowsProcessTreeExitUnverified = false
        }
        if (unverified && this.windowsProcessTreeTermination === termination) {
          this.windowsProcessTreeTermination = null
          this.windowsProcessTreeExitUnverified = true
        }
        if (this.windowsForceTerminationRequested && unverified && !this.hasExited) {
          this.windowsForceTerminationRequested = false
          this.terminateChild('SIGKILL')
        }
        if (!unverified && this.pendingDisposedExit) {
          this.finishExit(
            this.pendingDisposedExit.code,
            this.pendingDisposedExit.signal,
            this.pendingDisposedExit.cause
          )
        }
        return result
      })
      this.windowsProcessTreeTermination = termination
      return
    }
    void signalProcessTree(this.child, signal)
  }

  private async terminateWindowsChildTree(
    signal: NodeJS.Signals
  ): Promise<WindowsTerminationResult> {
    const pid = this.child.pid
    if (!pid) {
      return 'unverified'
    }
    const snapshot = await captureWindowsDescendantSnapshot(pid).catch(() => null)
    if (!snapshot) {
      // A ChildProcess handle still addresses the spawned root when table
      // inspection is unavailable; do not leave the session writer running.
      try {
        this.child.kill(signal)
      } catch {
        // The close handler supplies the actual exit observation.
      }
      return 'unverified'
    }
    const terminated = await terminateIdentifiedWindowsProcessTree(snapshot.root, {
      ownsRoot: () => !this.hasExited
    }).catch(() => false)
    if (!terminated) {
      return 'unverified'
    }
    return (await verifyWindowsDescendantSnapshotExit(snapshot).catch(() => 'unverifiable')) ===
      'exited'
      ? 'verified-tree'
      : 'unverified'
  }

  private forceTerminateChildTree(): void {
    if (process.platform === 'win32' || this.processTreeTerminationInFlight) {
      if (process.platform === 'win32' && !this.hasExited) {
        this.windowsForceTerminationRequested = this.windowsProcessTreeTermination !== null
        this.terminateChild('SIGKILL')
      }
      return
    }
    this.processTreeTerminationInFlight = true
    void forceTerminateProcessTree(this.child).then((verified) => {
      this.processTreeTerminationInFlight = false
      if (!verified) {
        return
      }
      this.processTreeTerminationVerified = true
      if (this.pendingDisposedExit) {
        this.finishExit(
          this.pendingDisposedExit.code,
          this.pendingDisposedExit.signal,
          this.pendingDisposedExit.cause
        )
      }
    })
  }

  private readonly handleStderr = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const retainedBytes = Math.max(0, STDERR_TAIL_BYTES - bytes.length)
    const retainedStart = Math.max(0, this.stderrBytes.length - retainedBytes)
    this.stderrBytes = Buffer.concat([this.stderrBytes.subarray(retainedStart), bytes]).subarray(
      -STDERR_TAIL_BYTES
    )
  }

  private readonly handleChildError = (error: Error): void => {
    this.childError ??= error
  }

  private readonly handleChildClose = (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    if (
      this.isDisposed &&
      process.platform === 'win32' &&
      (this.windowsProcessTreeTermination || this.windowsProcessTreeExitUnverified)
    ) {
      this.pendingDisposedExit = { code, signal, cause: this.childError }
      return
    }
    if (process.platform !== 'win32' && this.child.pid) {
      this.pendingDisposedExit = { code, signal, cause: this.childError }
      if (this.processTreeTerminationVerified) {
        this.finishExit(code, signal, this.childError)
      } else {
        this.forceTerminateChildTree()
      }
      return
    }
    this.finishExit(code, signal, this.childError)
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null, cause?: Error): void {
    if (this.hasExited) {
      return
    }
    this.hasExited = true
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer)
      this.forceKillTimer = null
    }
    this.removeListeners()
    this.handlers.onExit(code, signal, cause)
  }

  private removeListeners(): void {
    this.child.stdout?.removeListener('data', this.handleStdout)
    this.child.stderr?.removeListener('data', this.handleStderr)
    this.child.removeListener('error', this.handleChildError)
    this.child.removeListener('close', this.handleChildClose)
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.removeListener('error', this.handlers.onStreamError)
    }
  }
}
