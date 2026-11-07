import type { Endpoint } from '@number0/iroh'
import { vi } from 'vitest'

/** Native receive chunks whose pending reads advance only when the test supplies bytes. */
export class FakeRecv {
  private chunks: number[][] = []
  private waiters: ((value: number[]) => void)[] = []

  /** Deliver a chunk to the oldest pending native read, or queue it until one starts. */
  push(chunk: number[]): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(chunk)
      return
    }
    this.chunks.push(chunk)
  }

  end(): void {
    this.push([])
  }

  /** Keep reads pending instead of treating an empty test queue as stream EOF. */
  async read(_limit: number): Promise<number[]> {
    if (this.chunks.length > 0) {
      return this.chunks.shift()!
    }
    const pending = Promise.withResolvers<number[]>()
    this.waiters.push(pending.resolve)
    return await pending.promise
  }
}

/** Capture actual framed socket writes without implementing the framing or encryption. */
export class FakeSend {
  constructor(private readonly onWrite?: (chunk: Uint8Array) => void | Promise<void>) {}

  async writeAll(buf: number[]): Promise<void> {
    await this.onWrite?.(Uint8Array.from(buf))
  }
}

/** Inject the native endpoint boundary while retaining the real accept loop and framed socket. */
export function createFakeBind(recv: FakeRecv, send: FakeSend, endpointId = 'a'.repeat(64)) {
  const bi = { send, recv }
  const connection = {
    close: vi.fn(),
    acceptBi: vi.fn(async () => bi)
  }
  const accepting = {
    connect: vi.fn(async () => connection)
  }
  const incoming = {
    accept: vi.fn(async () => accepting),
    refuse: vi.fn(async () => {})
  }
  let acceptResolve: ((value: typeof incoming | null) => void) | null = null
  const endpoint = {
    online: vi.fn(async () => {}),
    acceptNext: vi.fn(async () => {
      const pending = Promise.withResolvers<typeof incoming | null>()
      acceptResolve = pending.resolve
      return await pending.promise
    }),
    close: vi.fn(async () => {
      acceptResolve?.(null)
    }),
    id: () => ({ toString: () => endpointId }),
    addr: () => ({
      relayUrl: () => 'https://actual.relay.example/',
      directAddresses: () => ['192.168.1.2:1234', '[::1]:1234']
    })
  }
  const bound = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The double provides every Endpoint method used by IrohTransport.
    endpoint: endpoint as unknown as Endpoint,
    endpointId
  }
  return {
    endpointId,
    bound,
    endpoint,
    connection,
    accepting,
    incoming,
    bi,
    pushIncoming: (next = incoming) => acceptResolve?.(next),
    bindEndpoint: vi.fn(
      async (_secretKey: number[], _alpn: number[], _relayUrl: string | null) => bound
    )
  }
}
