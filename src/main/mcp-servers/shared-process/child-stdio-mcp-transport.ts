// An MCP transport over a child Orca started itself, so the SDK's client speaks to it without the
// SDK spawning anything: the child comes from @orca/process-host, which owns Windows quoting and hiding.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export class ChildStdioMcpTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  // One message past the SDK's 10 MiB default would end the server for every agent using it.
  private readonly buffer = new ReadBuffer({ maxBufferSize: 64 * 1024 * 1024 })
  private closed = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  async start(): Promise<void> {
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        void this.close()
        return
      }
      for (;;) {
        let message: JSONRPCMessage | null
        try {
          message = this.buffer.readMessage()
        } catch {
          // A line that isn't JSON-RPC (a server logging to stdout) is skipped, as agents skip it.
          continue
        }
        if (!message) {
          return
        }
        this.onmessage?.(message)
      }
    })
    this.child.stdout.on('error', (error) => this.onerror?.(error))
    this.child.stdin.on('error', (error) => this.onerror?.(error))
    this.child.once('close', () => void this.close())
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.child.stdin.writable) {
        reject(new Error('The server’s process has ended.'))
        return
      }
      this.child.stdin.write(serializeMessage(message), (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  /** Ends stdin, which most stdio servers take as their cue to exit; the owner kills the rest. */
  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.buffer.clear()
    this.child.stdin.end()
    this.onclose?.()
  }
}

const STDERR_LOG_BUDGET_BYTES = 4 * 1024

/** The first few KiB of what the child writes to stderr, as warnings under its name. */
export function logChildStderr(name: string, child: ChildProcessWithoutNullStreams): void {
  let budget = STDERR_LOG_BUDGET_BYTES
  child.stderr.on('data', (chunk: Buffer) => {
    if (budget <= 0) {
      return
    }
    const text = chunk.toString('utf8', 0, Math.min(chunk.length, budget)).trimEnd()
    budget -= chunk.length
    console.warn(`[mcp-servers] ${name}: ${text}${budget <= 0 ? ' (further output dropped)' : ''}`)
  })
  child.stderr.on('error', () => {})
}
