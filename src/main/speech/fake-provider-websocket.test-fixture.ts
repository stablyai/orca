import { EventEmitter } from 'node:events'

/** Stands in for a `ws` socket so key probes run without a network. */
export class FakeProviderWebSocket extends EventEmitter {
  readonly OPEN = 1
  static instances: FakeProviderWebSocket[] = []
  static constructError: Error | null = null
  readyState = 0
  sent: (string | Buffer)[] = []
  closedWith: number | 'terminated' | null = null

  constructor(
    readonly url: string | URL,
    readonly headers?: Record<string, string>
  ) {
    super()
    if (FakeProviderWebSocket.constructError) {
      throw FakeProviderWebSocket.constructError
    }
    FakeProviderWebSocket.instances.push(this)
  }

  static reset(): void {
    FakeProviderWebSocket.instances = []
    FakeProviderWebSocket.constructError = null
  }

  static latest(): FakeProviderWebSocket {
    const socket = FakeProviderWebSocket.instances.at(-1)
    if (!socket) {
      throw new Error('no socket opened')
    }
    return socket
  }

  send(data: string | Buffer): void {
    this.sent.push(data)
  }

  close(code: number): void {
    this.closedWith = code
    this.readyState = 3
  }

  terminate(): void {
    this.closedWith = 'terminated'
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false)
  }
}
