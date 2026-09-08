import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import {
  Socks5NegotiationTimeoutError,
  Socks5RefusalError,
  type Socks5ConnectOptions
} from './socks5-connect'
import { TailcatSocksProxy, type TailcatProcessSpawner } from './tailcat-socks-proxy'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.signalCode = signal
    this.emit('exit', null, signal)
    return true
  }
}

function harness(
  connect: (options: Socks5ConnectOptions) => Promise<Socket>,
  now?: () => number,
  dialRetryDelayMs = 0
): {
  proxy: TailcatSocksProxy
  children: FakeChild[]
} {
  const children: FakeChild[] = []
  const spawn: TailcatProcessSpawner = (_spec: ProcessSpec) => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ReturnType<TailcatProcessSpawner>
  }
  const directory = mkdtempSync(join(tmpdir(), 'orca-tailcat-recovery-'))
  const keyPath = join(directory, 'client.private.json')
  writeFileSync(keyPath, '{}')
  return {
    proxy: new TailcatSocksProxy({
      binary: 'tailcat',
      keyPath,
      spawn,
      connect,
      dialRetryDelayMs,
      recoveryCooldownMs: 30_000,
      now
    }),
    children
  }
}

const tunnel = { v: 1 as const, kind: 'tailcat' as const, token: 'tcTOKEN', port: 6768 }
const genericFailure = (): Socks5RefusalError =>
  new Socks5RefusalError(0x01, 'SOCKS proxy refused the connection: general SOCKS server failure')
const socket = (): Socket => new EventEmitter() as Socket

async function ready(children: FakeChild[], index: number, port: number): Promise<void> {
  await vi.waitFor(() => expect(children).toHaveLength(index + 1))
  children[index]!.stderr.write(`SOCKS running at socks5h://127.0.0.1:${port}\n`)
}

describe('TailcatSocksProxy stale-child recovery', () => {
  it('replaces an idle generation after three generic failures and retries only through SOCKS', async () => {
    const established = socket()
    const connect = vi.fn(async ({ proxyPort }: { proxyPort: number }) => {
      if (proxyPort === 7) {
        throw genericFailure()
      }
      return established
    })
    const { proxy, children } = harness(connect)
    const dialed = proxy.dial(tunnel)
    await ready(children, 0, 7)
    await ready(children, 1, 8)

    await expect(dialed).resolves.toBe(established)
    expect(connect.mock.calls.map(([options]) => options.proxyPort)).toEqual([7, 7, 7, 8])
    expect(children[0]!.killed).toBe(true)
    established.emit('close')
    await proxy.stop()
  })

  it('coalesces concurrent recovery for the same stale generation', async () => {
    const oldFailures: (() => void)[] = []
    let oldCalls = 0
    const connect = vi.fn(({ proxyPort }: { proxyPort: number }): Promise<Socket> => {
      if (proxyPort !== 7) {
        return Promise.resolve(socket())
      }
      oldCalls += 1
      if (oldCalls < 5) {
        return Promise.reject(genericFailure())
      }
      return new Promise((_resolve, reject) => {
        oldFailures.push(() => reject(genericFailure()))
        if (oldFailures.length === 2) {
          oldFailures.splice(0).forEach((fail) => fail())
        }
      })
    })
    const { proxy, children } = harness(connect)
    const first = proxy.dial(tunnel)
    const second = proxy.dial(tunnel)
    await ready(children, 0, 7)
    await ready(children, 1, 8)

    const streams = await Promise.all([first, second])
    expect(children).toHaveLength(2)
    expect(children[0]!.killed).toBe(true)
    streams.forEach((stream) => stream.emit('close'))
    await proxy.stop()
  })

  it('resets retries when another recovery replaces the proxy during backoff', async () => {
    let replacementFailures = 0
    const established = socket()
    const connect = vi.fn(async ({ proxyPort }: { proxyPort: number }) => {
      if (proxyPort === 7) {
        throw genericFailure()
      }
      replacementFailures += 1
      if (replacementFailures < 3) {
        throw genericFailure()
      }
      return established
    })
    const { proxy, children } = harness(connect, () => 40_000, 100)
    const dialed = proxy.dial(tunnel)
    await ready(children, 0, 7)
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const recovery = (
      proxy as unknown as { recoverIdleProxy: (generation: number) => Promise<boolean> }
    ).recoverIdleProxy(1)
    await ready(children, 1, 8)
    await expect(recovery).resolves.toBe(true)

    await expect(dialed).resolves.toBe(established)
    expect(connect.mock.calls.map(([options]) => options.proxyPort)).toEqual([7, 8, 8, 8])
    established.emit('close')
    await proxy.stop()
  })

  it('does not retire a proxy with an established stream', async () => {
    const active = socket()
    let calls = 0
    const connect = vi.fn(async ({ proxyPort }: { proxyPort: number }) => {
      calls += 1
      if (calls === 1) {
        return active
      }
      if (proxyPort === 7) {
        throw genericFailure()
      }
      return socket()
    })
    const { proxy, children } = harness(connect)
    const first = proxy.dial(tunnel)
    await ready(children, 0, 7)
    await expect(first).resolves.toBe(active)
    await expect(proxy.dial(tunnel)).rejects.toThrow(/general SOCKS server failure/)
    expect(children).toHaveLength(1)
    expect(children[0]!.killed).toBe(false)

    active.emit('close')
    const recovered = proxy.dial(tunnel)
    await ready(children, 1, 8)
    const recoveredStream = await recovered
    recoveredStream.emit('close')
    await proxy.stop()
  })

  it('does not retire a proxy while another dial can still succeed', async () => {
    const pendingStream = socket()
    let releasePending: (() => void) | undefined
    let calls = 0
    const connect = vi.fn(({ proxyPort }: { proxyPort: number }): Promise<Socket> => {
      calls += 1
      if (calls === 1) {
        return new Promise((resolve) => {
          releasePending = () => resolve(pendingStream)
        })
      }
      expect(proxyPort).toBe(7)
      return Promise.reject(genericFailure())
    })
    const { proxy, children } = harness(connect)
    const pending = proxy.dial(tunnel)
    await ready(children, 0, 7)
    await vi.waitFor(() => expect(releasePending).toBeTypeOf('function'))

    await expect(proxy.dial(tunnel)).rejects.toThrow(/general SOCKS server failure/)
    expect(children).toHaveLength(1)
    releasePending!()
    await expect(pending).resolves.toBe(pendingStream)
    pendingStream.emit('close')
    await proxy.stop()
  })

  it('limits replacement churn to once per cooldown', async () => {
    let clock = 40_000
    const streams: Socket[] = []
    const connect = vi.fn(async ({ proxyPort }: { proxyPort: number }) => {
      if (proxyPort === 7 || (proxyPort === 8 && streams.length > 0)) {
        throw genericFailure()
      }
      const stream = socket()
      streams.push(stream)
      return stream
    })
    const { proxy, children } = harness(connect, () => clock)
    const first = proxy.dial(tunnel)
    await ready(children, 0, 7)
    await ready(children, 1, 8)
    const firstStream = await first
    firstStream.emit('close')

    clock += 29_999
    await expect(proxy.dial(tunnel)).rejects.toThrow(/general SOCKS server failure/)
    expect(children).toHaveLength(2)
    clock += 1
    const second = proxy.dial(tunnel)
    await ready(children, 2, 9)
    const secondStream = await second
    secondStream.emit('close')
    await proxy.stop()
  })

  it('never replaces for explicit refusal codes, but replaces after a negotiation deadline', async () => {
    const connect = vi
      .fn<({ proxyPort }: { proxyPort: number }) => Promise<Socket>>()
      .mockRejectedValueOnce(new Socks5RefusalError(0x02, 'policy denied'))
      .mockRejectedValueOnce(new Socks5RefusalError(0x02, 'policy denied'))
      .mockRejectedValueOnce(new Socks5RefusalError(0x02, 'policy denied'))
      .mockRejectedValueOnce(new Socks5NegotiationTimeoutError())
      .mockResolvedValueOnce(socket())
    const { proxy, children } = harness(connect)
    const denied = proxy.dial(tunnel)
    await ready(children, 0, 7)
    await expect(denied).rejects.toThrow(/policy denied/)
    expect(children).toHaveLength(1)

    const recovered = proxy.dial(tunnel)
    await ready(children, 1, 8)
    const stream = await recovered
    stream.emit('close')
    await proxy.stop()
  })
})
