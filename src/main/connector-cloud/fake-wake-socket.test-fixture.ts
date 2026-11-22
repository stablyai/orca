// Wake sockets that a test opens, wakes and closes by hand.
import { EventEmitter } from 'node:events'
import type { ConnectorWakeSocketFactory, ConnectorWakeSocketLike } from './connector-wake-socket'

export class FakeWakeSocket extends EventEmitter {
  readonly sent: string[] = []
  closed = false

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {
    super()
  }

  send(frame: string): void {
    this.sent.push(frame)
  }

  close(): void {
    this.closed = true
  }

  terminate(): void {
    this.closed = true
  }

  accept(): void {
    this.emit('open')
  }

  wake(): void {
    this.emit('message', Buffer.from('{"type":"wake"}'))
  }

  /** The server closes it with `code` after the upgrade. */
  end(code: number): void {
    this.closed = true
    this.emit('close', code)
  }

  /** The server answers the upgrade with `status`. */
  refuse(status: number, headers: Record<string, string> = {}): void {
    this.emit('unexpected-response', {}, { statusCode: status, headers })
    this.end(1006)
  }
}

export class FakeWakeSockets {
  readonly dialed: FakeWakeSocket[] = []

  readonly factory: ConnectorWakeSocketFactory = (url, headers): ConnectorWakeSocketLike => {
    const socket = new FakeWakeSocket(url, headers)
    this.dialed.push(socket)
    return socket
  }

  get last(): FakeWakeSocket | undefined {
    return this.dialed.at(-1)
  }
}
