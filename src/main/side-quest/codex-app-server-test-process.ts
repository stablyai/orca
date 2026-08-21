import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { CodexAppServerProcess } from './codex-app-server-process'

export class CodexAppServerTestProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly received: Record<string, unknown>[] = []
  readonly stdin: Writable
  readonly pid = 42
  killed = false
  private inputBuffer = ''

  constructor(
    private readonly onMessage: (
      message: Record<string, unknown>,
      process: CodexAppServerTestProcess
    ) => void
  ) {
    super()
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.inputBuffer += chunk.toString()
        this.drainInput()
        callback()
      }
    })
  }

  asProcess(): CodexAppServerProcess {
    return this as unknown as CodexAppServerProcess
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  sendRaw(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  close(code = 0): void {
    this.emit('close', code, null)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  private drainInput(): void {
    let newline = this.inputBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.inputBuffer.slice(0, newline)
      this.inputBuffer = this.inputBuffer.slice(newline + 1)
      if (line.trim()) {
        const message = JSON.parse(line) as Record<string, unknown>
        this.received.push(message)
        this.onMessage(message, this)
      }
      newline = this.inputBuffer.indexOf('\n')
    }
  }
}

export function initializeTestAppServer(
  message: Record<string, unknown>,
  process: CodexAppServerTestProcess
): boolean {
  if (message.method !== 'initialize') {
    return false
  }
  process.send({
    id: message.id,
    result: {
      userAgent: 'codex-test',
      codexHome: '/tmp/codex',
      platformFamily: 'unix',
      platformOs: 'linux'
    }
  })
  return true
}
