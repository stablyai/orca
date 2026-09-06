import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeLengthPrefixedFrame } from './iroh-frame-codec'
import { IrohTransport } from './iroh-transport'

class FakeRecv {
  private chunks: number[][] = []
  private waiters: ((value: number[]) => void)[] = []

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

  async read(_limit: number): Promise<number[]> {
    if (this.chunks.length > 0) {
      return this.chunks.shift()!
    }
    return await new Promise<number[]>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

class FakeSend {
  readonly written: number[][] = []
  async writeAll(buf: number[]): Promise<void> {
    this.written.push(buf)
  }
}

function createFakeBind(recv: FakeRecv, send: FakeSend, endpointId = 'a'.repeat(64)) {
  const connection = {
    close: vi.fn(),
    acceptBi: async () => ({ send, recv })
  }
  const accepting = {
    connect: async () => connection
  }
  const incoming = {
    accept: async () => accepting
  }
  let acceptResolve: ((value: typeof incoming | null) => void) | null = null
  const endpoint = {
    acceptNext: async () =>
      await new Promise<typeof incoming | null>((resolve) => {
        acceptResolve = resolve
      }),
    close: async () => {
      acceptResolve?.(null)
    },
    id: () => ({ toString: () => endpointId })
  }
  return {
    endpointId,
    connection,
    pushIncoming: () => acceptResolve?.(incoming),
    bindEndpoint: async () => ({
      endpoint: endpoint as never,
      endpointId
    })
  }
}

describe('IrohTransport', () => {
  const dirs: string[] = []
  const transports: IrohTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.stop().catch(() => {})))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts with an injected bind and exposes endpointId without loading native iroh', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    const transport = new IrohTransport({
      userDataPath,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)

    await transport.start()
    expect(transport.endpointId).toBe(fake.endpointId)
  })

  it('delivers length-prefixed text frames to the message handler', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)

    const received: string[] = []
    transport.onMessage((msg) => {
      if (typeof msg === 'string') {
        received.push(msg)
      }
    })
    await transport.start()
    fake.pushIncoming()
    // Why: acceptBi + readLoop arm asynchronously after acceptNext resolves.
    await new Promise((r) => setTimeout(r, 30))

    const hello = '{"type":"e2ee_hello","publicKeyB64":"x"}'
    const frame = encodeLengthPrefixedFrame(new TextEncoder().encode(hello))
    recv.push(Array.from(frame))

    await vi.waitFor(() => {
      expect(received).toEqual([hello])
    })
  })

  it('closes the freshly bound endpoint when coming online fails', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const close = vi.fn(async () => {})
    vi.doMock('@number0/iroh', () => ({
      Endpoint: {
        bind: async () => ({
          close,
          online: async () => {
            throw new Error('relay unreachable')
          },
          id: () => ({ toString: () => 'a'.repeat(64) })
        })
      }
    }))
    // Why: no injected bind here — this exercises the real native code path.
    const transport = new IrohTransport({ userDataPath })
    transports.push(transport)

    try {
      await expect(transport.start()).rejects.toThrow('relay unreachable')
      expect(close).toHaveBeenCalled()
    } finally {
      // Why: a failed assertion would otherwise leave the mock installed for
      // every later test in this file.
      vi.doUnmock('@number0/iroh')
    }
  })

  it('closes accepted connections whose bi-stream open fails', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    // Why: without a socket the pre-auth reaper can't see this connection —
    // the accept path itself must close it.
    fake.connection.acceptBi = async () => {
      throw new Error('open failed')
    }
    const transport = new IrohTransport({
      userDataPath,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)
    await transport.start()
    fake.pushIncoming()

    await vi.waitFor(() => {
      expect(fake.connection.close).toHaveBeenCalledWith(0n, [])
    })
  })

  it('terminates on oversize frames', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const send = new FakeSend()
    const fake = createFakeBind(recv, send)
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)
    await transport.start()
    fake.pushIncoming()
    await new Promise((r) => setTimeout(r, 20))

    const header = Buffer.alloc(4)
    header.writeUInt32BE(2 * 1024 * 1024, 0)
    recv.push(Array.from(header))

    await vi.waitFor(() => {
      expect(fake.connection.close).toHaveBeenCalled()
    })
  })
})
