import { ORCAD_WSL_DISTRO_GUID_ENV } from '../orcad/orcad-migration-wsl-destination'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { PipedChildProcess, PipedProcessSpec } from '@orca/process-host/process-spec'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { isWslOrcadHostTarget } from '../ssh/orcad-host-transport'
import { WSL_CHANNEL_CLOSE_GRACE_MS } from './wsl-command-channel'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { openOrcadStdioBridgeChannel, resolveOrcadStdioBridge } from '../ssh/orcad-stdio-bridge'
import { orcadBashStdioBridgeCommand } from '../managed-server/lifecycle/orcad-stdio-bridge-script'

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
  received: () => Buffer
  finish: (code: number | null, signal?: NodeJS.Signals | null) => void
}

function fakeChild(options: { spawnError?: Error } = {}): FakeChild {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const received: Buffer[] = []
  stdin.on('data', (chunk: Buffer) => received.push(chunk))
  const child: FakeChild = Object.assign(emitter, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      child.finish(null, 'SIGTERM')
      return true
    }),
    received: () => Buffer.concat(received),
    finish: (code: number | null, signal: NodeJS.Signals | null = null) => {
      child.exitCode = code
      child.signalCode = signal
      child.emit('exit', code, signal)
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('close', code, signal))
    }
  })
  process.nextTick(() =>
    options.spawnError ? child.emit('error', options.spawnError) : child.emit('spawn')
  )
  return child
}

function transportWith(children: FakeChild[]) {
  const specs: PipedProcessSpec[] = []
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: 'env-1', distro: 'Ubuntu-24.04', label: 'My Ubuntu' },
    commandLoops: false,
    spawn: (spec) => {
      specs.push(spec)
      const next = children.shift()
      if (!next) {
        throw new Error('no fake child left')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel reads only the streams, exit state, kill and events the fake provides.
      return next as unknown as PipedChildProcess
    }
  })
  return { transport, specs }
}

describe('createWslOrcadHostTransport', () => {
  it('runs the command through wsl.exe --exec sh -c in the chosen distro', async () => {
    const child = fakeChild()
    const { transport, specs } = transportWith([child])
    const channel = await transport.exec('echo $HOME')
    expect(specs[0]?.program).toMatch(/wsl(\.exe)?$/i)
    expect(specs[0]?.args).toEqual(['-d', 'Ubuntu-24.04', '--exec', 'sh', '-c', 'echo $HOME'])
    expect(specs[0]?.env?.WSL_UTF8).toBe('1')
    channel.close()
  })

  it('hands the bash bridge to sh through --exec, so wsl.exe never expands its $ words', async () => {
    const child = fakeChild()
    const { transport, specs } = transportWith([child])
    const bridge = await resolveOrcadStdioBridge(transport, 6768)
    const channel = await openOrcadStdioBridgeChannel(transport, bridge)
    expect(specs[0]?.args).toEqual([
      '-d',
      'Ubuntu-24.04',
      '--exec',
      'sh',
      '-c',
      orcadBashStdioBridgeCommand(6768)
    ])
    channel.close()
  })

  it('emits exit before close and reports the exit code on both', async () => {
    const child = fakeChild()
    const { transport } = transportWith([child])
    const channel = await transport.exec('true')
    const events: string[] = []
    channel.on('exit', (code: number) => events.push(`exit:${code}`))
    const closed = new Promise<void>((resolve) =>
      channel.on('close', (code: number) => {
        events.push(`close:${code}`)
        resolve()
      })
    )
    channel.resume()
    child.finish(0)
    await closed
    expect(events).toEqual(['exit:0', 'close:0'])
  })

  it('pipes stdin to the child and ends it', async () => {
    const child = fakeChild()
    const { transport } = transportWith([child])
    const ended = new Promise<void>((resolve) => child.stdin.on('end', resolve))
    const pending = execCommand(transport, 'cat >/dev/null', {
      stdin: Readable.from([Buffer.from('payload-'), Buffer.from('bytes')])
    })
    await ended
    child.finish(0)
    await pending
    expect(child.received().toString()).toBe('payload-bytes')
  })

  it('rejects a nonzero exit with its stderr', async () => {
    const child = fakeChild()
    const { transport } = transportWith([child])
    const pending = execCommand(transport, 'false')
    await new Promise((resolve) => setImmediate(resolve))
    child.stderr.write('boom\n')
    child.finish(3)
    await expect(pending).rejects.toThrow(/exit 3[\s\S]*boom/)
  })

  it('refuses an already-aborted exec without spawning', async () => {
    const { transport, specs } = transportWith([])
    const controller = new AbortController()
    controller.abort()
    await expect(transport.exec('true', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(specs).toHaveLength(0)
  })

  it('kills the child when an exec is aborted', async () => {
    // Only timers: the fake child's spawn and close still arrive on real ticks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const child = fakeChild()
      const { transport } = transportWith([child])
      const controller = new AbortController()
      const pending = execCommand(transport, 'sleep 300', { signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise((resolve) => setImmediate(resolve))
      controller.abort()
      // A guest ignoring stdin EOF is killed once the close grace runs out.
      await vi.advanceTimersByTimeAsync(WSL_CHANNEL_CLOSE_GRACE_MS)
      await rejected
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects exec when wsl.exe cannot be started', async () => {
    const { transport } = transportWith([fakeChild({ spawnError: new Error('spawn ENOENT') })])
    await expect(transport.exec('true')).rejects.toThrow('spawn ENOENT')
  })

  it('streams large stdout intact under backpressure', async () => {
    const child = fakeChild()
    const { transport } = transportWith([child])
    const channel = await transport.exec('cat big')
    const chunk = Buffer.alloc(1024 * 1024, 7)
    const received: Buffer[] = []
    const closed = new Promise<void>((resolve) => channel.on('close', () => resolve()))
    channel.on('data', (data: Buffer) => received.push(data))
    for (let i = 0; i < 20; i++) {
      child.stdout.write(chunk)
    }
    child.finish(0)
    await closed
    expect(Buffer.concat(received).length).toBe(20 * 1024 * 1024)
  })

  it('reports a stable WSL identity and never claims the system SSH transport', () => {
    const { transport } = transportWith([])
    const target = transport.getTarget()
    expect(target).toEqual({
      kind: 'wsl',
      id: 'env-1',
      distro: 'Ubuntu-24.04',
      label: 'My Ubuntu'
    })
    expect(isWslOrcadHostTarget(target)).toBe(true)
    expect(transport.usesSystemSshTransport()).toBe(false)
    expect(transport.getConnectGeneration()).toBe(transport.getConnectGeneration())
  })

  // Regression: `nohup … &` dies with its `wsl.exe --exec` on a distro without systemd.
  it('asks orcad launches to start in their own session', () => {
    expect(transportWith([]).transport.orcadLaunchDetach).toBe('setsid')
  })

  it('tells orcad which registration of the distro it runs in, when the registry knows', async () => {
    const make = (id: string | null) =>
      createWslOrcadHostTransport({
        target: { kind: 'wsl', id: 'env-1', distro: 'Ubuntu-24.04', label: 'My Ubuntu' },
        commandLoops: false,
        readDistroRegistryId: async (distro) => (distro === 'Ubuntu-24.04' ? id : null)
      })
    await expect(make('1a2b')?.orcadLaunchEnv?.({ fullVersion: '0.1.0+abc' })).resolves.toEqual([
      [ORCAD_WSL_DISTRO_GUID_ENV, '1a2b']
    ])
    await expect(make(null)?.orcadLaunchEnv?.({ fullVersion: '0.1.0+abc' })).resolves.toEqual([])
  })
})
