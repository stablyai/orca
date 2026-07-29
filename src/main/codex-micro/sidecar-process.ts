import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { buildPluginWorkerEnv } from '../plugins/plugin-worker-env'
import {
  CodexMicroFrameDecoder,
  encodeCodexMicroFrame,
  type CodexMicroFrameDecodeResult
} from './sidecar-frame-codec'

// Why: Node treats an unhandled child 'error' event as a process exception;
// a replaced child keeps this no-op listener instead of none at all.
function ignoreStaleChildError(): void {}

/**
 * Supervises one spawned codex-micro binary over framed stdio. Emits
 * `frame` for decoded stdout frames, `decode-error` with a coarse reason
 * only (never raw bytes), and forwards `exit`/`error`. Carries no restart
 * policy — that is the coordinator's job.
 */
export class CodexMicroSidecarProcess extends EventEmitter {
  private child: ChildProcess | null = null
  private decoder = new CodexMicroFrameDecoder()

  constructor(
    private readonly binaryPath: string,
    private readonly args: readonly string[] = []
  ) {
    super()
  }

  start(): void {
    if (this.child) {
      return
    }

    const child = spawn(this.binaryPath, [...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildPluginWorkerEnv(),
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })
    this.child = child
    this.decoder = new CodexMicroFrameDecoder()

    child.stdout?.on('data', (chunk: Buffer) => this.handleData(child, chunk))
    // Why: stderr may embed raw hidapi text; drain without forwarding it anywhere.
    child.stderr?.on('data', () => {})
    child.on('exit', (code, signal) => this.handleExit(child, code, signal))
    child.on('error', (error) => this.handleError(child, error))
  }

  write(message: Record<string, unknown>): void {
    if (!this.child?.stdin) {
      return
    }
    this.child.stdin.write(encodeCodexMicroFrame(message))
  }

  stop(): void {
    const child = this.child
    if (!child) {
      return
    }
    this.child = null
    child.off('error', () => {})
    child.on('error', ignoreStaleChildError)
    child.kill('SIGTERM')
  }

  private handleData(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child) {
      return
    }
    for (const result of this.decoder.push(chunk)) {
      if (result.ok) {
        this.emit('frame', result.value)
      } else {
        this.emit('decode-error', result.reason)
      }
    }
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
    this.emit('exit', code, signal)
  }

  private handleError(child: ChildProcess, error: Error): void {
    if (this.child !== child) {
      return
    }
    this.child = null
    this.emit('error', error)
  }
}

export type { CodexMicroFrameDecodeResult }
