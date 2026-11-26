import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  bootHarmonyDevice,
  pickHdcPort,
  startInstanceArgs,
  type HarmonyBootOptions
} from './harmony-avd-boot'
import type { HarmonyLaunchFailure } from './harmony-launch-diagnostic'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import type { HarmonyEmulatorInstance } from './harmony-emulator-instances'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

// Yielding a macrotask lets setImmediate-scheduled child 'close' events run between poll iterations.
const macrotaskSleep = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const options: HarmonyBootOptions = {
  bootTimeoutMs: 1000,
  pollIntervalMs: 100,
  sleep: vi.fn(macrotaskSleep),
  // Keep timeout tests from writing real diagnostic files; tests that assert on failures inject their own.
  writeLaunchDiagnostic: vi.fn(() => null)
}

function instance(overrides: Partial<HarmonyEmulatorInstance> = {}): HarmonyEmulatorInstance {
  return {
    name: 'Mate 90 Pro',
    instancePath: '/d/Mate 90 Pro',
    imageRoot: '/images',
    isRunning: false,
    ...overrides
  }
}

// launchInstance needs piped stdio plus the exit/error events a real ChildProcess emits.
type FakeChild = EventEmitter & {
  unref: ReturnType<typeof vi.fn>
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function makeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    unref: vi.fn(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
}

// Node emits 'exit' then 'close' as macrotask events; the launcher settles on 'close' so piped
// stdio chunks have drained by then.
function exitChild(
  child: FakeChild,
  code: number | null,
  signal: NodeJS.Signals | null = null
): void {
  setImmediate(() => {
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  })
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function diagnostic(
  calls: HarmonyLaunchFailure[] = []
): NonNullable<HarmonyBootOptions['writeLaunchDiagnostic']> {
  return vi.fn((failure: HarmonyLaunchFailure) => {
    calls.push(failure)
    return '/tmp/orca-fake-launch-diagnostic.log'
  })
}

describe('pickHdcPort', () => {
  it('returns the first free port in range', () => {
    expect(pickHdcPort(new Set())).toBe(10000)
    expect(pickHdcPort(new Set([10000]))).toBe(10001)
  })

  it('throws when the whole range is taken', () => {
    const taken = new Set<number>()
    for (let port = 10000; port <= 16555; port++) {
      taken.add(port)
    }
    expect(() => pickHdcPort(taken)).toThrow(
      expect.objectContaining({ code: 'emulator_helper_failed' })
    )
  })
})

describe('startInstanceArgs', () => {
  it('includes paths and the fixed port', () => {
    expect(startInstanceArgs(instance(), 10000)).toEqual([
      '-start',
      'Mate 90 Pro',
      '-instancePath',
      '/d',
      '-imageRoot',
      '/images',
      '-hdcPort',
      '10000'
    ])
  })

  it('omits unknown paths', () => {
    expect(startInstanceArgs(instance({ instancePath: '', imageRoot: '' }), 10000)).toEqual([
      '-start',
      'Mate 90 Pro',
      '-hdcPort',
      '10000'
    ])
  })
})

describe('bootHarmonyDevice', () => {
  it('returns an already-live target without starting anything', async () => {
    const run = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: '127.0.0.1:5555',
      stderr: '',
      code: 0
    }))
    const key = await bootHarmonyDevice(run, SDK, '127.0.0.1:5555', [], options)
    expect(key).toBe('127.0.0.1:5555')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('resolves a correlated running instance name', async () => {
    const instances = [instance({ isRunning: true, hdcPort: 5555 })]
    const run = vi.fn<HarmonyCommandRunner>(async (_b, args) => {
      if (args.join(' ') === 'list targets') {
        return { stdout: '127.0.0.1:5555', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const key = await bootHarmonyDevice(run, SDK, 'Mate 90 Pro', instances, options)
    expect(key).toBe('127.0.0.1:5555')
  })

  it('throws for an unknown name', async () => {
    const run = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: '[Empty]',
      stderr: '',
      code: 0
    }))
    await expect(bootHarmonyDevice(run, SDK, 'Nope', [], options)).rejects.toMatchObject({
      code: 'emulator_device_not_found'
    })
  })

  it('boots a stopped instance (spawned) and polls until the target appears', async () => {
    let connected = false
    const instances = [instance()]
    const failures: HarmonyLaunchFailure[] = []
    spawnMock.mockImplementation(() => {
      connected = true
      return makeChild()
    })
    const run = vi.fn<HarmonyCommandRunner>(async (binary, args) => {
      const command = args.join(' ')
      if (binary === SDK.hdc && command === `tconn 127.0.0.1:10000`) {
        return { stdout: '', stderr: '', code: 0 }
      }
      if (binary === SDK.hdc && command === 'list targets') {
        return { stdout: connected ? '127.0.0.1:10000' : '[Empty]', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    const key = await bootHarmonyDevice(run, SDK, 'Mate 90 Pro', instances, {
      ...options,
      sleep: vi.fn(async () => {}),
      writeLaunchDiagnostic: diagnostic(failures)
    })

    expect(key).toBe('127.0.0.1:10000')
    expect(spawnMock).toHaveBeenCalledWith(
      SDK.emulator,
      startInstanceArgs(instance(), 10000),
      expect.objectContaining({ stdio: 'pipe', windowsHide: true })
    )
    expect(failures).toEqual([])
    spawnMock.mockReset()
  })

  it('fails fast on a non-zero early exit and surfaces the emulator stderr', async () => {
    const failures: HarmonyLaunchFailure[] = []
    spawnMock.mockImplementation(() => {
      const child = makeChild()
      child.stderr.write('Emulator: GLib: fatal startup error')
      exitChild(child, 1, null)
      return child
    })
    const run = vi.fn<HarmonyCommandRunner>(async (_binary, args) =>
      args.join(' ') === 'list targets'
        ? { stdout: '[Empty]', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    )

    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
        ...options,
        writeLaunchDiagnostic: diagnostic(failures)
      })
    ).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('fatal startup error')
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      reason: 'exited before the hdc target connected',
      code: 1,
      stderr: 'Emulator: GLib: fatal startup error'
    })
    spawnMock.mockReset()
  })

  it('treats a zero-code exit inside the early-exit grace window as a failed boot', async () => {
    const failures: HarmonyLaunchFailure[] = []
    spawnMock.mockImplementation(() => {
      const child = makeChild()
      exitChild(child, 0, null)
      return child
    })
    const run = vi.fn<HarmonyCommandRunner>(async (_binary, args) =>
      args.join(' ') === 'list targets'
        ? { stdout: '[Empty]', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    )

    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
        ...options,
        writeLaunchDiagnostic: diagnostic(failures)
      })
    ).rejects.toMatchObject({ code: 'emulator_helper_failed' })
    expect(failures[0]?.code).toBe(0)
    expect(failures[0]?.reason).toContain('exited before')
    spawnMock.mockReset()
  })

  it('keeps polling past the grace window when the process exited cleanly without a target', async () => {
    const failures: HarmonyLaunchFailure[] = []
    let child: FakeChild
    spawnMock.mockImplementation(() => {
      child = makeChild()
      return child
    })
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === 2) {
        exitChild(child!, 0, null)
      }
      await macrotaskSleep()
    })
    const run = vi.fn<HarmonyCommandRunner>(async (_binary, args) =>
      args.join(' ') === 'list targets'
        ? { stdout: '[Empty]', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    )

    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
        bootTimeoutMs: 15_000,
        pollIntervalMs: 6_000,
        sleep,
        writeLaunchDiagnostic: diagnostic(failures)
      })
    ).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('did not connect in time')
    })
    expect(failures[0]?.reason).toContain('did not connect')
    spawnMock.mockReset()
  })

  it('does not flag an exit that arrives after the hdc target came online', async () => {
    const failures: HarmonyLaunchFailure[] = []
    let child: FakeChild
    let spawned = false
    spawnMock.mockImplementation(() => {
      spawned = true
      child = makeChild()
      return child
    })
    const run = vi.fn<HarmonyCommandRunner>(async (binary, args) => {
      const command = args.join(' ')
      if (binary === SDK.hdc && command === 'list targets') {
        return { stdout: spawned ? '127.0.0.1:10000' : '[Empty]', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    const key = await bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
      ...options,
      writeLaunchDiagnostic: diagnostic(failures)
    })
    expect(key).toBe('127.0.0.1:10000')
    exitChild(child!, 1, null)
    await nextTick()
    expect(failures).toEqual([])
    spawnMock.mockReset()
  })

  it('prunes Offline loopback targets before spawning and tolerates removal failures', async () => {
    let spawned = false
    spawnMock.mockImplementation(() => {
      spawned = true
      return makeChild()
    })
    const run = vi.fn<HarmonyCommandRunner>(async (binary, args) => {
      const command = args.join(' ')
      if (binary === SDK.hdc && command === 'list targets -v') {
        return {
          stdout: '127.0.0.1:10000\t\tTCP\tOffline\tunknown...\thdc',
          stderr: '',
          code: 0
        }
      }
      if (binary === SDK.hdc && command === 'tconn 127.0.0.1:10000 -remove') {
        // hdc 3.2.0f reports failure here even at exit 0.
        return { stdout: '', stderr: '[Fail]No target available', code: 0 }
      }
      if (binary === SDK.hdc && command === 'list targets') {
        return { stdout: spawned ? '127.0.0.1:10000' : '[Empty]', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    const key = await bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
      ...options,
      writeLaunchDiagnostic: diagnostic()
    })
    expect(key).toBe('127.0.0.1:10000')
    expect(run).toHaveBeenCalledWith(SDK.hdc, ['tconn', '127.0.0.1:10000', '-remove'])
    spawnMock.mockReset()
  })

  it('reports the requested and actual ports in the timeout diagnostics', async () => {
    const failures: HarmonyLaunchFailure[] = []
    spawnMock.mockImplementation(() => makeChild())
    const reboundDetails = JSON.stringify([
      {
        name: 'Mate 90 Pro',
        instancePath: '/d/Mate 90 Pro',
        imageRoot: '/images',
        isRunning: 'true',
        'hw.hdc.port': '5557'
      }
    ])
    const run = vi.fn<HarmonyCommandRunner>(async (binary, args) => {
      const command = args.join(' ')
      if (binary === SDK.emulator && command === '-list -details') {
        return { stdout: reboundDetails, stderr: '', code: 0 }
      }
      if (binary === SDK.hdc && command === 'list targets -v') {
        return {
          stdout: '127.0.0.1:5557\t\tTCP\tConnected\tlocalhost\thdc',
          stderr: '',
          code: 0
        }
      }
      if (binary === SDK.hdc && command === 'list targets') {
        return { stdout: '[Empty]', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
        bootTimeoutMs: 200,
        pollIntervalMs: 100,
        sleep: vi.fn(async () => {}),
        writeLaunchDiagnostic: diagnostic(failures)
      })
    ).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('Requested hdc port 10000')
    })
    const outcome: unknown = await bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
      bootTimeoutMs: 200,
      pollIntervalMs: 100,
      sleep: vi.fn(async () => {}),
      writeLaunchDiagnostic: diagnostic(failures)
    }).catch((error: unknown) => error)
    if (!(outcome instanceof Error)) {
      throw new Error('expected the boot to fail with a timeout diagnostic')
    }
    expect(outcome.message).toContain('hdcPort=5557')
    expect(outcome.message).toContain('127.0.0.1:5557 (connected)')
    expect(failures.at(-1)?.diagnostics).toContain('hdcPort=5557')
    spawnMock.mockReset()
  })

  it('reports a synchronous spawn failure through the diagnostic path', async () => {
    const failures: HarmonyLaunchFailure[] = []
    spawnMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    const run = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: '[Empty]',
      stderr: '',
      code: 0
    }))

    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
        ...options,
        writeLaunchDiagnostic: diagnostic(failures)
      })
    ).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('EACCES')
    })
    expect(failures[0]?.reason).toBe('could not start')

    // The reserved port is released on spawn failure.
    let respawned = false
    spawnMock.mockImplementation(() => {
      respawned = true
      return makeChild()
    })
    const runAgain = vi.fn<HarmonyCommandRunner>(async (_binary, args) =>
      args.join(' ') === 'list targets'
        ? { stdout: respawned ? '127.0.0.1:10000' : '[Empty]', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    )
    await bootHarmonyDevice(runAgain, SDK, 'Mate 90 Pro', [instance()], {
      ...options,
      writeLaunchDiagnostic: diagnostic()
    })
    expect(spawnMock.mock.calls.at(-1)?.[1]).toEqual(startInstanceArgs(instance(), 10000))
    spawnMock.mockReset()
  })

  it('caps captured emulator stderr so diagnostics stay bounded', async () => {
    const failures: HarmonyLaunchFailure[] = []
    const cap = 64 * 1024
    spawnMock.mockImplementation(() => {
      const child = makeChild()
      child.stderr.write('x'.repeat(cap * 2))
      exitChild(child, 1, null)
      return child
    })
    const run = vi.fn<HarmonyCommandRunner>(async (_binary, args) =>
      args.join(' ') === 'list targets'
        ? { stdout: '[Empty]', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    )

    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
        ...options,
        writeLaunchDiagnostic: diagnostic(failures)
      })
    ).rejects.toMatchObject({ code: 'emulator_helper_failed' })
    expect(failures[0]?.stderr).toHaveLength(cap)
    spawnMock.mockReset()
  })

  it('does not relaunch an already-running instance; waits for its target to register', async () => {
    const instances = [instance({ isRunning: true })]
    let registered = false
    const relistInstances = vi.fn(async () => [instance({ isRunning: true, hdcPort: 5555 })])
    const run = vi.fn<HarmonyCommandRunner>(async (_b, args) => {
      if (args.join(' ') === 'list targets') {
        return { stdout: registered ? '127.0.0.1:5555' : '[Empty]', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const key = await bootHarmonyDevice(run, SDK, 'Mate 90 Pro', instances, {
      ...options,
      sleep: vi.fn(async () => {
        registered = true
      }),
      relistInstances
    })
    expect(key).toBe('127.0.0.1:5555')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('times out when a running instance never registers a target', async () => {
    const run = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: '[Empty]',
      stderr: '',
      code: 0
    }))
    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance({ isRunning: true })], options)
    ).rejects.toMatchObject({ code: 'emulator_helper_failed' })
  })

  it('reserves distinct ports for concurrent boots', async () => {
    let bReserved = false
    let allowAToPoll: () => void = () => {}
    const aGate = new Promise<void>((resolve) => {
      allowAToPoll = resolve
    })
    const run = vi.fn<HarmonyCommandRunner>(async (binary, args) => {
      const command = args.join(' ')
      if (binary === SDK.hdc && command === 'list targets') {
        return {
          stdout: bReserved ? '127.0.0.1:10000\n127.0.0.1:10001' : '[Empty]',
          stderr: '',
          code: 0
        }
      }
      if (command === 'tconn 127.0.0.1:10000') {
        await aGate
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    spawnMock.mockImplementation(() => {
      if (spawnMock.mock.calls.length === 2) {
        bReserved = true
        allowAToPoll()
      }
      return makeChild()
    })

    const aBoot = bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], options)
    const bBoot = bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], options)

    const [a, b] = await Promise.all([aBoot, bBoot])
    expect(a).toBe('127.0.0.1:10000')
    expect(b).toBe('127.0.0.1:10001')
    const ports = spawnMock.mock.calls.map((call) => call[1]?.at(-1))
    expect(ports).toContain('10000')
    expect(ports).toContain('10001')
    spawnMock.mockReset()
  })

  it('times out when the new target never registers', async () => {
    const sleep = vi.fn(async () => {})
    spawnMock.mockImplementation(() => makeChild())
    const run = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: '[Empty]',
      stderr: '',
      code: 0
    }))
    await expect(
      bootHarmonyDevice(run, SDK, 'Mate 90 Pro', [instance()], {
        ...options,
        sleep
      })
    ).rejects.toMatchObject({ code: 'emulator_helper_failed' })
    expect(sleep).toHaveBeenCalled()
    spawnMock.mockReset()
  })
})
