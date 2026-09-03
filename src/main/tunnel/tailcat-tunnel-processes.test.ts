import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { resolveTailcatBinary, tailcatKeyPathArgument } from './tailcat-binary'
import { TailcatSocksProxy, type TailcatProcessSpawner } from './tailcat-socks-proxy'
import { Socks5RefusalError } from './socks5-connect'
import type { Socket } from 'node:net'
import { parseListenAddress, TailcatTunnelServer } from './tailcat-tunnel-server'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  signals: NodeJS.Signals[] = []
  ignoresSigterm = false

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.signals.push(signal)
    if (signal === 'SIGTERM' && this.ignoresSigterm) {
      return true
    }
    this.exit(null, signal)
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return
    }
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function fakeSpawner(): {
  spawn: TailcatProcessSpawner
  children: FakeChild[]
  specs: ProcessSpec[]
} {
  const children: FakeChild[] = []
  const specs: ProcessSpec[] = []
  const spawn: TailcatProcessSpawner = (spec) => {
    specs.push(spec)
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ReturnType<TailcatProcessSpawner>
  }
  return { spawn, children, specs }
}

const runOk = vi.fn(async () => ({
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false
}))

async function spawned(children: FakeChild[], count: number): Promise<FakeChild> {
  await vi.waitFor(() => expect(children).toHaveLength(count))
  return children[count - 1]!
}

function existingKeyPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tailcat-key-'))
  const keyPath = join(directory, 'orca-server.private.json')
  writeFileSync(keyPath, '{}')
  return keyPath
}

describe('resolveTailcatBinary', () => {
  it('finds an executable on PATH and falls back to ~/.local/bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-tailcat-bin-'))
    const onPath = join(root, 'path-dir')
    const home = join(root, 'home')
    const localBin = join(home, '.local', 'bin')
    mkdirSync(onPath, { recursive: true })
    mkdirSync(localBin, { recursive: true })
    const pathBinary = join(onPath, 'tailcat')
    const localBinary = join(localBin, 'tailcat')
    writeFileSync(pathBinary, '#!/bin/sh\n')
    chmodSync(pathBinary, 0o755)
    writeFileSync(localBinary, '#!/bin/sh\n')
    chmodSync(localBinary, 0o755)

    const fallbackDirectories = [join(root, 'absent'), localBin]
    const resolve = (env: NodeJS.ProcessEnv): string | null =>
      resolveTailcatBinary({ env, platform: 'linux', home, fallbackDirectories })

    expect(resolve({ PATH: onPath })).toBe(pathBinary)
    expect(resolve({ PATH: join(root, 'missing') })).toBe(localBinary)
    expect(resolve({ ORCA_TAILCAT_PATH: localBinary, PATH: onPath })).toBe(localBinary)
    expect(resolve({ ORCA_TAILCAT_PATH: join(root, 'nope'), PATH: onPath })).toBeNull()
    expect(resolve({ PATH: [join(root, 'missing'), onPath].join(delimiter) })).toBe(pathBinary)
  })

  it('looks for tailcat.exe on Windows without probing POSIX directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-tailcat-bin-'))
    const binary = join(root, 'tailcat.exe')
    writeFileSync(binary, '')
    expect(resolveTailcatBinary({ env: { Path: root }, platform: 'win32', home: root })).toBe(
      binary
    )
    expect(
      resolveTailcatBinary({ env: { Path: join(root, 'missing') }, platform: 'win32', home: root })
    ).toBeNull()
  })

  it('passes key paths to tailcat with forward slashes', () => {
    expect(tailcatKeyPathArgument('C:\\Users\\o\\orca\\tailcat\\server.private.json')).toBe(
      'C:/Users/o/orca/tailcat/server.private.json'
    )
    expect(tailcatKeyPathArgument('/home/o/server.private.json')).toBe(
      '/home/o/server.private.json'
    )
  })
})

describe('parseListenAddress', () => {
  it('extracts the address blob from the --json ready line only', () => {
    expect(parseListenAddress('{"listenAddr":"tcABC"}')).toBe('tcABC')
    expect(parseListenAddress('{"listenAddr":"nope"}')).toBeNull()
    expect(parseListenAddress('# Selected bootstrap relay region 302')).toBeNull()
  })
})

describe('TailcatTunnelServer', () => {
  it('spawns tailcat serve for the runtime port and resolves the address blob', async () => {
    const { spawn, children, specs } = fakeSpawner()
    const keyPath = existingKeyPath()
    const states: string[] = []
    const server = new TailcatTunnelServer({
      binary: '/usr/bin/tailcat',
      keyPath,
      spawn,
      run: runOk,
      onStateChange: (state) => states.push(state)
    })

    const pending = server.start(6768)
    const child = await spawned(children, 1)
    expect(specs[0]?.args).toEqual([
      `--key=${tailcatKeyPathArgument(keyPath)}`,
      '--json',
      'serve',
      '6768'
    ])
    child.stdout.write('{"listenAddr":"tcTOKEN"}\n')
    await expect(pending).resolves.toBe('tcTOKEN')
    expect(server.getToken()).toBe('tcTOKEN')
    expect(server.getState()).toBe('running')
    expect(runOk).not.toHaveBeenCalled()
    await expect(server.start(6768)).resolves.toBe('tcTOKEN')
    expect(children).toHaveLength(1)

    await server.stop()
    expect(children[0]!.killed).toBe(true)
    expect(states).toEqual(['starting', 'running', 'stopped'])
  })

  it('generates a fixed-region key before the first launch', async () => {
    const { spawn, children } = fakeSpawner()
    const run = vi.fn(async (spec: ProcessSpec) => {
      writeFileSync(spec.args![1]!.slice('--key='.length), '{}')
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    })
    const keyPath = join(
      mkdtempSync(join(tmpdir(), 'orca-tailcat-key-')),
      'orca-server.private.json'
    )
    const server = new TailcatTunnelServer({ binary: 'tailcat', keyPath, spawn, run })
    const pending = server.start(6768)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(run.mock.calls[0]![0].args).toEqual([
      'genkey',
      `--key=${tailcatKeyPathArgument(keyPath)}`,
      '--fixed-region'
    ])
    children[0]!.stdout.write('{"listenAddr":"tcTOKEN"}\n')
    await expect(pending).resolves.toBe('tcTOKEN')
    await server.stop()
  })

  it('fails when the child exits before announcing a listener', async () => {
    const { spawn, children } = fakeSpawner()
    const server = new TailcatTunnelServer({
      binary: 'tailcat',
      keyPath: existingKeyPath(),
      spawn,
      run: runOk
    })
    const pending = server.start(6768)
    const child = await spawned(children, 1)
    child.stderr.write('tailcat: bind failed\n')
    child.exit(1)
    await expect(pending).rejects.toThrow(/exited \(1\)/)
    // Why: the server is still wanted, so a failed launch queues a retry instead of giving up.
    expect(server.getState()).toBe('starting')
    await server.stop()
    expect(server.getState()).toBe('stopped')
  })

  it('settles a launch that stop() cancels and spawns nothing afterwards', async () => {
    const { spawn, children } = fakeSpawner()
    const server = new TailcatTunnelServer({
      binary: 'tailcat',
      keyPath: existingKeyPath(),
      spawn,
      run: runOk,
      restartDelaysMs: [1]
    })
    const pending = server.start(6768)
    await spawned(children, 1)
    await server.stop()
    await expect(pending).rejects.toThrow(/was stopped/)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(children).toHaveLength(1)
    expect(server.getState()).toBe('stopped')
  })

  it('keeps retrying with backoff when a relaunch dies before it is ready', async () => {
    vi.useFakeTimers()
    try {
      const { spawn, children } = fakeSpawner()
      const server = new TailcatTunnelServer({
        binary: 'tailcat',
        keyPath: existingKeyPath(),
        spawn,
        run: runOk,
        restartDelaysMs: [10, 20]
      })
      const pending = server.start(6768)
      const first = await spawned(children, 1)
      first.stdout.write('{"listenAddr":"tcTOKEN"}\n')
      await pending
      first.exit(1)
      await vi.advanceTimersByTimeAsync(15)
      const second = await spawned(children, 2)
      second.exit(1)
      expect(server.getState()).toBe('starting')
      await vi.advanceTimersByTimeAsync(25)
      const third = await spawned(children, 3)
      third.stdout.write('{"listenAddr":"tcTOKEN"}\n')
      await vi.waitFor(() => expect(server.getState()).toBe('running'))
      await server.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets start() inside a backoff window own the relaunch', async () => {
    vi.useFakeTimers()
    try {
      const { spawn, children } = fakeSpawner()
      const server = new TailcatTunnelServer({
        binary: 'tailcat',
        keyPath: existingKeyPath(),
        spawn,
        run: runOk,
        restartDelaysMs: [1_000]
      })
      const pending = server.start(6768)
      const first = await spawned(children, 1)
      first.stdout.write('{"listenAddr":"tcTOKEN"}\n')
      await pending
      first.exit(1)
      const restarted = server.start(6768)
      const second = await spawned(children, 2)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(children).toHaveLength(2)
      second.stdout.write('{"listenAddr":"tcTOKEN"}\n')
      await expect(restarted).resolves.toBe('tcTOKEN')
      await server.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates the previous child before serving a different port', async () => {
    const { spawn, children, specs } = fakeSpawner()
    const server = new TailcatTunnelServer({
      binary: 'tailcat',
      keyPath: existingKeyPath(),
      spawn,
      run: runOk
    })
    const first = server.start(6768)
    const firstChild = await spawned(children, 1)
    firstChild.stdout.write('{"listenAddr":"tcTOKEN"}\n')
    await first
    const replaced = server.start(7000)
    const secondChild = await spawned(children, 2)
    expect(firstChild.killed).toBe(true)
    expect(firstChild.signalCode).toBe('SIGTERM')
    expect(specs[1]?.args).toContain('7000')
    secondChild.stdout.write('{"listenAddr":"tcTOKEN"}\n')
    await expect(replaced).resolves.toBe('tcTOKEN')
    expect(server.getPort()).toBe(7000)
    await server.stop()
    expect(secondChild.killed).toBe(true)
  })

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const { spawn, children } = fakeSpawner()
    const server = new TailcatTunnelServer({
      binary: 'tailcat',
      keyPath: existingKeyPath(),
      spawn,
      run: runOk,
      terminateGraceMs: 10
    })
    const pending = server.start(6768)
    const child = await spawned(children, 1)
    child.ignoresSigterm = true
    child.stdout.write('{"listenAddr":"tcTOKEN"}\n')
    await pending
    await server.stop()
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('survives a child stream error', async () => {
    const { spawn, children } = fakeSpawner()
    const server = new TailcatTunnelServer({
      binary: 'tailcat',
      keyPath: existingKeyPath(),
      spawn,
      run: runOk
    })
    const pending = server.start(6768)
    const child = await spawned(children, 1)
    child.stdout.write('{"listenAddr":"tcTOKEN"}\n')
    await pending
    expect(() => child.stderr.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(server.getState()).toBe('running')
    await server.stop()
  })

  it('relaunches with the same key after an unexpected exit', async () => {
    vi.useFakeTimers()
    try {
      const { spawn, children } = fakeSpawner()
      const server = new TailcatTunnelServer({
        binary: 'tailcat',
        keyPath: existingKeyPath(),
        spawn,
        run: runOk,
        restartDelaysMs: [50]
      })
      const pending = server.start(6768)
      const first = await spawned(children, 1)
      first.stdout.write('{"listenAddr":"tcTOKEN"}\n')
      await pending
      first.exit(1)
      expect(server.getState()).toBe('starting')
      await vi.advanceTimersByTimeAsync(60)
      const second = await spawned(children, 2)
      second.stdout.write('{"listenAddr":"tcTOKEN"}\n')
      await vi.waitFor(() => expect(server.getState()).toBe('running'))
      await server.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TailcatSocksProxy', () => {
  it('starts one proxy, reads its port from stderr, and reuses it', async () => {
    const { spawn, children, specs } = fakeSpawner()
    const keyPath = existingKeyPath()
    const proxy = new TailcatSocksProxy({ binary: 'tailcat', keyPath, spawn, run: runOk })
    const started = (proxy as unknown as { ensureStarted: () => Promise<number> }).ensureStarted()
    const child = await spawned(children, 1)
    expect(specs[0]?.args).toEqual([
      `--key=${tailcatKeyPathArgument(keyPath)}`,
      'socks',
      '--listen=127.0.0.1:0'
    ])
    child.stderr.write('2026/09/02 21:31:59 SOCKS running at socks5h://127.0.0.1:60809\n')
    await expect(started).resolves.toBe(60809)
    expect(proxy.getPort()).toBe(60809)
    await expect(
      (proxy as unknown as { ensureStarted: () => Promise<number> }).ensureStarted()
    ).resolves.toBe(60809)
    expect(children).toHaveLength(1)

    child.exit(0)
    expect(proxy.getPort()).toBeNull()
    await proxy.stop()
  })

  it('does not spawn a proxy when stopped during key generation', async () => {
    const { spawn, children } = fakeSpawner()
    let releaseKeygen: () => void = () => {}
    const run = vi.fn(
      (spec: ProcessSpec) =>
        new Promise<{
          code: number
          signal: null
          stdout: string
          stderr: string
          timedOut: boolean
        }>((resolve) => {
          releaseKeygen = () => {
            writeFileSync(spec.args![2]!.slice('--key='.length), '{}')
            resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
          }
        })
    )
    const keyPath = join(
      mkdtempSync(join(tmpdir(), 'orca-tailcat-key-')),
      'orca-client.private.json'
    )
    const proxy = new TailcatSocksProxy({ binary: 'tailcat', keyPath, spawn, run })
    const tunnel = { v: 1 as const, kind: 'tailcat' as const, token: 'tcTOKEN', port: 6768 }
    const dialed = proxy.dial(tunnel)
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    await proxy.stop()
    releaseKeygen()
    await expect(dialed).rejects.toThrow(/has been stopped/)
    expect(children).toHaveLength(0)
  })

  it('creates a client key first when none exists', async () => {
    const { spawn, children } = fakeSpawner()
    const run = vi.fn(async (spec: ProcessSpec) => {
      writeFileSync(spec.args![2]!.slice('--key='.length), '{}')
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    })
    const keyPath = join(
      mkdtempSync(join(tmpdir(), 'orca-tailcat-key-')),
      'orca-client.private.json'
    )
    const proxy = new TailcatSocksProxy({ binary: 'tailcat', keyPath, spawn, run })
    const started = (proxy as unknown as { ensureStarted: () => Promise<number> }).ensureStarted()
    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(run.mock.calls[0]![0].args).toEqual([
      'genkey',
      '--client',
      `--key=${tailcatKeyPathArgument(keyPath)}`
    ])
    children[0]!.stderr.write('SOCKS running at socks5h://127.0.0.1:5\n')
    await expect(started).resolves.toBe(5)
    await proxy.stop()
  })

  it('retries a dial the proxy refused, but not a proxy that is unreachable', async () => {
    const { spawn, children } = fakeSpawner()
    const socket = {} as Socket
    const connect = vi
      .fn<() => Promise<Socket>>()
      .mockRejectedValueOnce(new Socks5RefusalError('general SOCKS server failure'))
      .mockResolvedValueOnce(socket)
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    const proxy = new TailcatSocksProxy({
      binary: 'tailcat',
      keyPath: existingKeyPath(),
      spawn,
      run: runOk,
      connect,
      dialRetryDelayMs: 1
    })
    const tunnel = { v: 1 as const, kind: 'tailcat' as const, token: 'tcTOKEN', port: 6768 }
    const dialed = proxy.dial(tunnel)
    const child = await spawned(children, 1)
    child.stderr.write('SOCKS running at socks5h://127.0.0.1:7\n')
    await expect(dialed).resolves.toBe(socket)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[0]).toEqual([{ proxyPort: 7, host: 'tcTOKEN', port: 6768 }])

    await expect(proxy.dial(tunnel)).rejects.toThrow(/ECONNREFUSED/)
    expect(connect).toHaveBeenCalledTimes(3)
    await proxy.stop()
  })
})
