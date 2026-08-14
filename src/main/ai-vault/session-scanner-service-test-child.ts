import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

export class AiVaultServiceTestChild extends EventEmitter {
  readonly sent: unknown[] = []
  readonly stderr = new EventEmitter()
  readonly pid: number
  killed = false
  unrefed = false

  constructor(pid = 12_345) {
    super()
    this.pid = pid
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  unref(): this {
    this.unrefed = true
    return this
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

export function readyAiVaultServiceChild(child: AiVaultServiceTestChild): void {
  child.emit('message', { type: 'ready', protocol: 1, pid: child.pid })
}

export function aiVaultServiceRequestId(child: AiVaultServiceTestChild, operation: string): number {
  const request = child.sent.find(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { operation?: string }).operation === operation
  ) as { id?: number } | undefined
  if (request?.id === undefined) {
    throw new Error(`No ${operation} request was sent.`)
  }
  return request.id
}
