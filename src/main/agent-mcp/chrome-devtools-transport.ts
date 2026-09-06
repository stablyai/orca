import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'

const MAX_PENDING_BYTES = 64 * 1024 * 1024

export class ChromeDevtoolsTransport implements Transport {
  onclose?: Transport['onclose']
  onerror?: Transport['onerror']
  onmessage?: Transport['onmessage']
  private child?: ReturnType<typeof spawnProcess>
  private readonly buffer = new ReadBuffer()
  private pendingBytes = 0
  private closed = false
  private stderr = ''

  constructor(private readonly spec: ProcessSpec) {}

  async start(): Promise<void> {
    if (this.child || this.closed) {
      throw new Error('Chrome DevTools transport cannot be restarted.')
    }
    const child = spawnProcess({ ...this.spec, detached: process.platform !== 'win32' })
    this.child = child
    const fail = (error: Error): void => {
      this.onerror?.(error)
      this.finish()
      void this.close()
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8192)
    })
    child.once('close', (code) => {
      if (!this.closed) {
        this.onerror?.(new Error(`Chrome DevTools MCP exited (${code}): ${this.stderr}`))
      }
      this.finish()
    })
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.pendingBytes += chunk.length
        if (this.pendingBytes > MAX_PENDING_BYTES) {
          throw new Error('Chrome DevTools MCP response exceeded 64 MiB.')
        }
        this.buffer.append(chunk)
        let message: JSONRPCMessage | null
        while ((message = this.buffer.readMessage()) !== null) {
          this.onmessage?.(message)
        }
        const newline = chunk.lastIndexOf(10)
        if (newline !== -1) {
          this.pendingBytes = chunk.length - newline - 1
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child
    if (!child || this.closed) {
      return Promise.reject(new Error('Chrome DevTools MCP is disconnected.'))
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()))
    })
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.finish()
    if (!child) {
      return
    }
    child.stdin.end()
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    const exited = await new Promise<boolean>((resolve) => {
      const onClose = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        child.removeListener('close', onClose)
        resolve(false)
      }, 2000)
      child.once('close', onClose)
    })
    if (!exited) {
      await forceTerminateProcessTree(child)
    }
  }

  private finish(): void {
    if (!this.closed) {
      this.closed = true
      this.buffer.clear()
      this.onclose?.()
    }
  }
}
