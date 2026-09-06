export class FakeCdpSocket {
  evaluations: {
    id: number
    params: { expression: string; returnByValue: boolean }
  }[] = []
  private readonly values: string[]
  private messageListener: ((data: Buffer) => void) | undefined

  constructor(values: string[]) {
    this.values = [...values]
  }

  once(event: string, listener: (value?: unknown) => void): void {
    if (event === 'open') {
      queueMicrotask(listener)
    }
  }

  on(event: string, listener: (data: Buffer) => void): void {
    if (event === 'message') {
      this.messageListener = listener
    }
  }

  send(payload: string): void {
    this.evaluations.push(JSON.parse(payload))
    const value = this.values.shift() ?? ''
    queueMicrotask(() => {
      this.messageListener?.(Buffer.from(JSON.stringify({ id: 1, result: { result: { value } } })))
    })
  }

  close(): void {}
}

export class FakeProcessTerminationSocket {
  command: unknown
  private messageListener: ((data: Buffer) => void) | undefined

  once(event: string, listener: (value?: unknown) => void): void {
    if (event === 'open') {
      queueMicrotask(listener)
    }
  }

  on(event: string, listener: (data: Buffer) => void): void {
    if (event === 'message') {
      this.messageListener = listener
    }
  }

  send(payload: string): void {
    this.command = JSON.parse(payload)
    queueMicrotask(() => {
      this.messageListener?.(
        Buffer.from(
          JSON.stringify({
            method: 'Inspector.detached',
            params: { reason: 'Render process gone.' }
          })
        )
      )
    })
  }

  close(): void {}
}

export function fakeCdpConstructor(socket: FakeCdpSocket | FakeProcessTerminationSocket) {
  return class {
    constructor() {
      return socket
    }
  }
}
