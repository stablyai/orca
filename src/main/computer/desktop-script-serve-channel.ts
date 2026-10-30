import { StringDecoder } from 'node:string_decoder'
import type {
  PipedChildProcess,
  PipedProcessSpawner,
  PipedProcessSpec
} from '@orca/process-host/process-spec'
import { ownRetainedString } from '../../shared/own-retained-string'

export type RuntimeChildProcess = PipedChildProcess

export type RuntimeProcessSpawn = PipedProcessSpawner

/** UTF-16 units, not bytes — this bounds the buffer, it is not a payload contract. */
const MAX_RESPONSE_CHARS = 20 * 1024 * 1024
const MAX_STDERR_CHARS = 4096

export type ServeChannelHandlers = {
  onLine: (line: string) => void
  /** The helper is gone; detail carries the exit reason and its stderr tail. */
  onGone: (detail: string) => void
  onOverflow: () => void
}

/** Reassemble large NDJSON replies across chunks, preserving split UTF-8 code points. */
export class DesktopScriptServeChannel {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private stderrTail = ''
  private detach: (() => void) | null = null
  private closed = false

  constructor(
    private readonly child: RuntimeChildProcess,
    private readonly handlers: ServeChannelHandlers
  ) {
    const onStdout = (chunk: Buffer | string): void => this.readStdout(chunk)
    const onStderr = (chunk: Buffer | string): void => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-MAX_STDERR_CHARS)
    }
    // close, unlike exit, guarantees stderr is drained before failure classification.
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      this.reportGone(signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`)
    const onError = (error: Error): void => this.reportGone(error.message)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('close', onClose)
    child.once('error', onError)
    // Unhandled stdin errors would terminate the sidecar.
    child.stdin.on('error', () => {})
    this.detach = (): void => {
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('close', onClose)
      child.off('error', onError)
      child.on('error', () => {})
    }
  }

  write(payload: string, onError: (error: Error) => void): void {
    if (this.closed) {
      return
    }
    this.child.stdin.write(payload, (error) => {
      // Ignore errors after stop() so a destroyed stdin cannot charge the same failure twice.
      if (error && !this.closed) {
        onError(error)
      }
    })
  }

  stop(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.detach?.()
    this.detach = null
    this.buffer = ''
    // End the serve loop; kill also covers helpers wedged in native calls.
    try {
      this.child.stdin.end()
    } catch {
      /* already closed */
    }
    this.child.kill()
  }

  private reportGone(detail: string): void {
    if (this.closed) {
      return
    }
    const text = [detail, this.stderrTail.trim()].filter(Boolean).join(': ')
    this.closed = true
    this.detach?.()
    this.detach = null
    this.handlers.onGone(text)
  }

  private readStdout(chunk: Buffer | string): void {
    if (this.closed) {
      return
    }
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const retainedLength = this.buffer.length
    this.buffer += decoded
    if (this.buffer.length > MAX_RESPONSE_CHARS) {
      this.buffer = ''
      this.handlers.onOverflow()
      return
    }
    // The retained tail has no newline, so only the new chunk needs scanning for the first one.
    const firstNewline = decoded.indexOf('\n')
    if (firstNewline === -1) {
      return
    }
    for (let newline = retainedLength + firstNewline; newline >= 0;) {
      // Slice a trailing CR off by index; trimming copies the whole payload.
      const end = newline > 0 && this.buffer.charCodeAt(newline - 1) === 13 ? newline - 1 : newline
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) {
        this.handlers.onLine(line)
        // A handler may have stopped this channel; stop reading its backlog.
        if (this.closed) {
          this.buffer = ''
          return
        }
      }
      newline = this.buffer.indexOf('\n')
    }
    // Copy the retained slice so it cannot pin a drained megabyte-scale response.
    this.buffer = ownRetainedString(this.buffer)
  }
}

export function startServeChannel(
  spec: PipedProcessSpec,
  spawn: RuntimeProcessSpawn,
  handlers: ServeChannelHandlers
): DesktopScriptServeChannel {
  return new DesktopScriptServeChannel(spawn(spec), handlers)
}
