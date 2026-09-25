import { describe, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from '../../../src/shared/browser-network-tunnel-client'
import {
  BrowserNetworkTunnelOpcode as Op,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate,
  decodeBrowserNetworkTunnelFrame
} from '../../../src/shared/browser-network-tunnel-protocol'
import {
  AndroidBrowserTunnelSocket,
  type AndroidBrowserByteStream
} from './android-browser-tunnel-socket'
import { readAndroidSocksTarget } from './android-browser-socks-handshake'

const tick = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

function stream(reads: (Uint8Array | null)[] = []): AndroidBrowserByteStream {
  return {
    read: vi.fn(async () => reads.shift() ?? null),
    write: vi.fn(async () => {}),
    close: vi.fn()
  }
}

async function coreHarness() {
  const sent: Uint8Array[] = []
  let retained = 0
  const core = new BrowserNetworkTunnelClient(
    {
      tunnelGeneration: 1,
      sendBinary: (bytes) => {
        sent.push(bytes.slice())
        return true
      },
      outboundMemory: {
        claimApplicationBytes: (bytes) => {
          retained += bytes
          return () => {
            retained -= bytes
          }
        }
      }
    },
    (callbacks) => new AndroidBrowserTunnelSocket(callbacks)
  )
  const receive = (opcode: Op, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    core.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, streamId: 1, tunnelGeneration: 1, payload })
    )
  const opening = core.open({ host: 'only-execution-host.invalid', port: 443 })
  receive(Op.Opened)
  const socket = await opening
  return { core, socket, sent, receive, retained: () => retained }
}

describe('Android SOCKS parsing over bounded native pulls', () => {
  const cases = [
    { address: [1, 127, 0, 0, 1], host: '127.0.0.1' },
    { address: [3, 7, ...new TextEncoder().encode('a.testx')], host: 'a.testx' },
    { address: [4, ...Array.from({ length: 15 }, () => 0), 1], host: '0:0:0:0:0:0:0:1' }
  ]
  it.each(cases)(
    'parses every split of $host without local resolution',
    async ({ address, host }) => {
      const bytes = new Uint8Array([5, 1, 0, 5, 1, 0, ...address, 1, 187])
      for (let split = 1; split < bytes.length; split++) {
        const sink = stream([bytes.slice(0, split), bytes.slice(split)])
        const request = await readAndroidSocksTarget(sink)
        expect(request.target).toEqual({ host, port: 443 })
      }
      const sink = stream(Array.from(bytes, (byte) => new Uint8Array([byte])))
      expect((await readAndroidSocksTarget(sink)).target.host).toBe(host)
    }
  )
  it('retains pipelined application bytes', async () => {
    const sink = stream([new Uint8Array([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 80, 8, 9])])
    expect((await readAndroidSocksTarget(sink)).initial).toEqual(new Uint8Array([8, 9]))
  })
  it.each([
    [5, 1, 2],
    [5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 80],
    [5, 1, 0, 5, 1, 0, 3, 0],
    [5, 1, 0, 5, 1, 0, 9],
    [5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 0]
  ])('fails closed for invalid request %j', async (...bytes) => {
    await expect(readAndroidSocksTarget(stream([new Uint8Array(bytes)]))).rejects.toThrow()
  })
})

describe('Android socket with the real portable tunnel core', () => {
  it('does not read the next native chunk until core send credit consumes this one', async () => {
    const h = await coreHarness()
    const sink = stream([new Uint8Array([3]), null])
    h.socket.start(sink, new Uint8Array([1, 2]))
    await tick()
    expect(sink.read).not.toHaveBeenCalled()
    expect(h.retained()).toBe(2)
    h.receive(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(2))
    await tick()
    expect(sink.read).toHaveBeenCalledTimes(1)
    h.receive(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    await tick()
    const frames = h.sent.map(decodeBrowserNetworkTunnelFrame)
    expect(frames.filter((f) => f?.opcode === Op.Data).map((f) => [...f!.payload])).toEqual([
      [1, 2],
      [3]
    ])
    expect(frames.at(-1)?.opcode).toBe(Op.HalfClose)
    h.core.close()
    expect(h.retained()).toBe(0)
  })
  it('credits completed native writes and consumes EOF only after shutdown', async () => {
    const h = await coreHarness()
    const completions: (() => void)[] = []
    const writes: (Uint8Array | null)[] = []
    const sink = stream()
    sink.write = (bytes) => {
      writes.push(bytes)
      return new Promise((resolve) => completions.push(resolve))
    }
    h.socket.start(sink, new Uint8Array())
    h.receive(Op.Data, new Uint8Array(32769).fill(7))
    h.receive(Op.HalfClose)
    await tick()
    expect(writes.map((b) => b?.length)).toEqual([16384])
    expect(h.socket.readableEnded).toBe(false)
    expect(h.retained()).toBe(32769)
    for (let i = 0; i < 3; i++) {
      completions.shift()!()
      await tick()
    }
    expect(writes.map((b) => b?.length ?? null)).toEqual([16384, 16384, 1, null])
    expect(h.retained()).toBe(0)
    expect(h.socket.readableEnded).toBe(false)
    completions.shift()!()
    await tick()
    expect(h.socket.readableEnded).toBe(true)
    const ended = vi.fn()
    h.socket.onReadableEnd(ended)
    expect(ended).toHaveBeenCalledOnce()
    h.core.close()
  })
  it('handles EOF received before the native sink binds', async () => {
    const h = await coreHarness()
    h.receive(Op.HalfClose)
    await tick()
    expect(h.socket.readableEnded).toBe(false)
    const sink = stream()
    h.socket.start(sink, new Uint8Array())
    await tick()
    expect(sink.write).toHaveBeenCalledWith(null)
    expect(h.socket.readableEnded).toBe(true)
    h.core.close()
  })
  it('disposes stalled I/O without granting late credit', async () => {
    const h = await coreHarness()
    let complete = () => {}
    const sink = stream()
    sink.write = () =>
      new Promise((resolve) => {
        complete = resolve
      })
    h.socket.start(sink, new Uint8Array())
    h.receive(Op.Data, new Uint8Array([4]))
    await tick()
    h.core.close()
    const count = h.sent.length
    complete()
    await tick()
    expect(h.sent).toHaveLength(count)
    expect(sink.close).toHaveBeenCalledOnce()
    expect(h.retained()).toBe(0)
    expect(h.socket.readableEnded).toBe(false)
  })
})

it('releases actual core claims when native close throws and disposal repeats', async () => {
  const h = await coreHarness()
  const native = stream()
  vi.mocked(native.close).mockImplementation(() => {
    throw new Error('Proxy route closed')
  })
  h.socket.start(native, new Uint8Array([1, 2, 3]))
  expect(h.retained()).toBe(3)
  expect(() => h.socket.destroy()).not.toThrow()
  h.socket.destroy()
  await tick()
  expect(h.retained()).toBe(0)
  expect(native.close).toHaveBeenCalledOnce()
  h.core.close()
})

it('settles a rejected late native read without a throwing rejection handler', async () => {
  const h = await coreHarness()
  let rejectRead!: (error: Error) => void
  const native = stream()
  vi.mocked(native.read).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject
      })
  )
  vi.mocked(native.close).mockImplementation(() => {
    throw new Error('Proxy route closed')
  })
  h.socket.start(native, new Uint8Array())
  rejectRead(new Error('Module destroyed'))
  await tick()
  expect(h.socket.destroyed).toBe(true)
  expect(h.retained()).toBe(0)
  expect(native.close).toHaveBeenCalledOnce()
  h.core.close()
})
