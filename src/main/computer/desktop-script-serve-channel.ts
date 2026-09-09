import { StringDecoder } from 'node:string_decoder'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type { spawnProcess } from '../../shared/child-process/run-process'

/** The all-pipes child `spawnProcess` returns; avoids a node:child_process import. */
export type RuntimeChildProcess = ReturnType<typeof spawnProcess>

export type RuntimeProcessSpawn = (spec: ProcessSpec) => RuntimeChildProcess

/** UTF-16 units, not bytes — this bounds the buffer, it is not a payload contract. */
const MAX_RESPONSE_CHARS = 20 * 1024 * 1024
const MAX_STDERR_CHARS = 4096

export type ServeChannelHandlers = {
  /** One complete line from the helper, without its terminator. */
  onLine: (line: string) => void
  /** The helper is gone; detail carries the exit reason and its stderr tail. */
  onGone: (detail: string) => void
  /** The helper produced more than one buffer's worth without a line break. */
  onOverflow: () => void
}

/**
 * One `runtime.ps1 -Serve` child, framed as NDJSON lines.
 *
 * Split from the host so the host reads as what it is — a queue, a retry policy
 * and a correlation check — rather than that plus stream plumbing. Responses
 * carry base64 screenshots and routinely exceed a megabyte, so lines are
 * reassembled across chunks with a decoder that survives a code point split
 * across a chunk boundary.
 */
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
    // Why close and not exit: the caller classifies the failure from stderr, and
    // only close guarantees the stdio streams were drained first.
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      this.reportGone(signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`)
    const onError = (error: Error): void => this.reportGone(error.message)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('close', onClose)
    child.once('error', onError)
    // An unhandled stream error is an uncaught exception in the main process.
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
      // A destroyed stdin calls back after stop(); reporting then charges the
      // caller a second failure for one operation. Deliberately redundant with
      // the host's own staleness check — keep both, and note that each is
      // pinned separately, this one by the "once stopped" tests here.
      if (error && !this.closed) {
        onError(error)
      }
    })
  }

  /** Stop the helper and go silent; handlers are not called afterwards. */
  stop(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.detach?.()
    this.detach = null
    this.buffer = ''
    // Closing stdin ends the serve loop; the kill covers a wedged helper.
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
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (this.buffer.length > MAX_RESPONSE_CHARS) {
      this.buffer = ''
      this.handlers.onOverflow()
      return
    }
    for (let newline = this.buffer.indexOf('\n'); newline >= 0;) {
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
  }
}

export function startServeChannel(
  spec: ProcessSpec,
  spawn: RuntimeProcessSpawn,
  handlers: ServeChannelHandlers
): DesktopScriptServeChannel {
  return new DesktopScriptServeChannel(spawn(spec), handlers)
}
