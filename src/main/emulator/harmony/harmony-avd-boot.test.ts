import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  bootHarmonyDevice,
  pickHdcPort,
  startInstanceArgs,
  type HarmonyBootOptions
} from './harmony-avd-boot'

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

const options: HarmonyBootOptions = {
  bootTimeoutMs: 1000,
  pollIntervalMs: 100,
  sleep: vi.fn(async () => {})
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
      sleep: vi.fn(async () => {})
    })

    expect(key).toBe('127.0.0.1:10000')
    expect(spawnMock).toHaveBeenCalledWith(
      SDK.emulator,
      startInstanceArgs(instance(), 10000),
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    )
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
    spawnMock.mockImplementation(makeChild)
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

// launchInstance only uses `.on('error')` and `.unref()`.
function makeChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { unref: () => {} })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fake ChildProcess; launchInstance only calls on('error')/unref.
  return child as unknown as ChildProcess
}
