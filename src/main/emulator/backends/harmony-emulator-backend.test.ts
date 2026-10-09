import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { HarmonyEmulatorBackend } from './harmony-emulator-backend'
import type { HarmonyCommandResult, HarmonyCommandRunner } from '../harmony/harmony-command-runner'
import type { HarmonySdkPaths } from '../harmony/harmony-sdk-discovery'
import type { EmulatorSessionInfo } from '../emulator-types'
import type { StartHarmonyStream } from '../harmony/harmony-stream-session-starter'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// launchInstance only uses `.on('error')` and `.unref()`.
function makeSpawnedChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { unref: () => {} })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fake ChildProcess; launchInstance only calls on('error')/unref.
  return child as unknown as ChildProcess
}

type HarmonyRunnerMock = ReturnType<typeof vi.fn<HarmonyCommandRunner>>

const runnerMocks = new WeakMap<HarmonyEmulatorBackend, HarmonyRunnerMock>()

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

const KEY = '127.0.0.1:5555'

const DETAILS = JSON.stringify([
  {
    name: 'Mate 90 Pro',
    instancePath: '/d/Mate 90 Pro',
    imageRoot: '/images',
    isRunning: 'true',
    'hw.hdc.port': '5555',
    'hw.lcd.single.width': '1280',
    'hw.lcd.single.height': '2832',
    'os.apiVersion': '26'
  }
])

type RunnerOptions = {
  details?: string
  targets?: () => string
  generic?: (args: readonly string[]) => HarmonyCommandResult
}

function makeRunner(options: RunnerOptions = {}): HarmonyRunnerMock {
  return vi.fn<HarmonyCommandRunner>(async (binary, args) => {
    const command = args.join(' ')
    if (binary === SDK.emulator && command === '-list -details') {
      return { stdout: options.details ?? DETAILS, stderr: '', code: 0 }
    }
    if (binary === SDK.hdc && command === 'list targets') {
      return { stdout: (options.targets ?? (() => KEY))(), stderr: '', code: 0 }
    }
    if (binary === SDK.hdc && command.includes('shell snapshot_display')) {
      return { stdout: 'success as jpeg, width: 1280, height: 2832', stderr: '', code: 0 }
    }
    if (options.generic) {
      return options.generic(args)
    }
    return { stdout: '', stderr: '', code: 0 }
  })
}

function track(harmony: HarmonyEmulatorBackend, runner: HarmonyRunnerMock): HarmonyEmulatorBackend {
  runnerMocks.set(harmony, runner)
  return harmony
}

function backend(
  options: RunnerOptions & Parameters<typeof makeBackend>[0] = {}
): HarmonyEmulatorBackend {
  const { details, targets, generic, ...backendOptions } = options
  const runner = makeRunner({ details, targets, generic })
  return track(makeBackend({ ...backendOptions, runner }), runner)
}

function makeBackend(
  options: {
    runner?: HarmonyCommandRunner
    sdk?: HarmonySdkPaths | null
    deployedRoots?: readonly string[]
    bootTimeoutMs?: number
    pollIntervalMs?: number
    frameIntervalMs?: number
    sleep?: (ms: number) => Promise<void>
    startStreamSession?: StartHarmonyStream
  } = {}
): HarmonyEmulatorBackend {
  return new HarmonyEmulatorBackend({ deployedRoots: [], sdk: SDK, ...options })
}

function sessionInfo(key: string): EmulatorSessionInfo {
  return {
    deviceUdid: key,
    wsUrl: '',
    streamUrl: 'http://127.0.0.1:9/stream.mjpeg',
    streamCodec: 'mjpeg',
    backend: 'harmonyos'
  }
}

describe('HarmonyEmulatorBackend identity', () => {
  it('declares the harmonyos backend with mjpeg and the capability set', () => {
    const harmony = backend()
    expect(harmony.kind).toBe('harmonyos')
    expect(harmony.streamCodec).toBe('mjpeg')
    expect(harmony.capabilities).toEqual({
      install: true,
      launch: true,
      permissions: false,
      accessibilityTree: true,
      logcat: false
    })
  })
})

describe('HarmonyEmulatorBackend support and availability', () => {
  it('reports ready with devices when the toolchain resolves', async () => {
    const harmony = backend()
    expect(harmony.isSupportedOnHost()).toBe(true)
    const availability = await harmony.checkAvailability()
    expect(availability).toMatchObject({
      available: true,
      message: 'Ready',
      sdkPath: '/sdk'
    })
  })

  it('reports the setup message when no toolchain is found', async () => {
    const harmony = makeBackend({ runner: makeRunner(), sdk: null })
    expect(harmony.isSupportedOnHost()).toBe(false)
    const availability = await harmony.checkAvailability()
    expect(availability.available).toBe(false)
    expect(availability.message).toContain('DevEco Studio')
  })

  it('asks the user to create an instance when none exist', async () => {
    const harmony = backend({
      details: '[]',
      targets: () => '[Empty]'
    })
    const availability = await harmony.checkAvailability()
    expect(availability).toMatchObject({ available: false, sdkPath: '/sdk' })
    expect(availability.message).toContain('Create one in DevEco Studio')
  })

  it('surfaces runner errors instead of claiming availability', async () => {
    const runner = vi.fn<HarmonyCommandRunner>(async () => {
      throw new Error('hdc boom')
    })
    const harmony = makeBackend({ runner })
    const availability = await harmony.checkAvailability()
    expect(availability).toMatchObject({ available: false, message: 'hdc boom' })
  })
})

describe('HarmonyEmulatorBackend device listing', () => {
  it('lists the booted instance and resolves ownership', async () => {
    const harmony = backend()
    const devices = await harmony.listDevices()
    expect(devices).toEqual([
      {
        backend: 'harmonyos',
        id: KEY,
        name: 'Mate 90 Pro',
        state: 'booted',
        detail: 'emulator',
        isAvailable: true
      }
    ])
    expect(await harmony.ownsDevice(KEY)).toBe(true)
    expect(await harmony.ownsDevice('Mate 90 Pro')).toBe(true)
    expect(await harmony.ownsDevice('nope')).toBe(false)
  })

  it('lists unpaired physical targets as devices', async () => {
    const harmony = backend({ details: '[]', targets: () => 'USBSER123' })
    const devices = await harmony.listDevices()
    expect(devices).toEqual([
      {
        backend: 'harmonyos',
        id: 'USBSER123',
        name: 'USBSER123',
        state: 'booted',
        detail: 'device',
        isAvailable: true
      }
    ])
  })
})

describe('HarmonyEmulatorBackend id resolution', () => {
  it('resolves connectKeys and correlated instance names', async () => {
    const harmony = backend()
    expect(await harmony.resolveDeviceId(KEY)).toBe(KEY)
    expect(await harmony.resolveDeviceId('Mate 90 Pro')).toBe(KEY)
  })

  it('throws for a target that is not running', async () => {
    const harmony = backend()
    await expect(harmony.resolveDeviceId('Nope')).rejects.toMatchObject({
      code: 'emulator_device_not_found'
    })
  })
})

describe('HarmonyEmulatorBackend sessions', () => {
  it('starts once, reuses the session, and closes on helper stop', async () => {
    const close = vi.fn()
    const startStreamSession = vi.fn<StartHarmonyStream>(async () => ({
      info: sessionInfo(KEY),
      handle: { close }
    }))

    const harmony = backend({ startStreamSession })

    const info = await harmony.startSession(KEY)
    expect(info).toEqual(sessionInfo(KEY))
    expect(await harmony.startSession(KEY)).toBe(info)
    expect(startStreamSession).toHaveBeenCalledTimes(1)
    expect(await harmony.isSessionReusable(info)).toBe(true)

    await harmony.stopHelperForDevice(KEY)
    expect(close).toHaveBeenCalledTimes(1)
    expect(await harmony.isSessionReusable(info)).toBe(false)
  })

  it('boots a stopped instance before streaming', async () => {
    const stoppedDetails = JSON.stringify([
      { name: 'MatePad Pro', instancePath: '/d/MatePad Pro', imageRoot: '', isRunning: 'false' }
    ])
    let started = false
    spawnMock.mockImplementation(() => {
      started = true
      return makeSpawnedChild()
    })
    const runner = vi.fn<HarmonyCommandRunner>(async (binary, args) => {
      const command = args.join(' ')
      if (binary === SDK.emulator && command === '-list -details') {
        return { stdout: stoppedDetails, stderr: '', code: 0 }
      }
      if (binary === SDK.hdc && command === `tconn 127.0.0.1:10000`) {
        return { stdout: '', stderr: '', code: 0 }
      }
      if (binary === SDK.hdc && command === 'list targets') {
        return { stdout: started ? '127.0.0.1:10000' : '[Empty]', stderr: '', code: 0 }
      }
      if (binary === SDK.hdc && command.includes('shell snapshot_display')) {
        return { stdout: 'success as jpeg, width: 1280, height: 2832', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    const startStreamSession = vi.fn<StartHarmonyStream>(async ({ connectKey }) => ({
      info: sessionInfo(connectKey),
      handle: { close: vi.fn() }
    }))

    const harmony = track(
      makeBackend({
        runner,
        startStreamSession,
        bootTimeoutMs: 2000,
        pollIntervalMs: 20,
        sleep: vi.fn(async () => {})
      }),
      runner
    )

    const info = await harmony.startSession('MatePad Pro')
    expect(info.deviceUdid).toBe('127.0.0.1:10000')
    expect(spawnMock).toHaveBeenCalledWith(
      SDK.emulator,
      expect.arrayContaining(['-start', 'MatePad Pro', '-hdcPort', '10000']),
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    )
    spawnMock.mockReset()
  })
})

describe('HarmonyEmulatorBackend input', () => {
  it('taps at pixels scaled from the instance lcd size', async () => {
    const harmony = backend()
    await harmony.tap(KEY, 0.5, 0.5)
    const runner = harmonyRunner(harmony)
    const tapCall = runner.mock.calls.find((call) => call[1].includes('uinput'))
    expect(tapCall?.[1]).toEqual(['-t', KEY, 'shell', 'uinput', '-T', '-c', '640', '1416'])
  })

  it('sends a straight swipe for a gesture', async () => {
    const harmony = backend()
    await harmony.gesture(
      KEY,
      [
        { type: 'begin', x: 0.25, y: 0.1 },
        { type: 'end', x: 0.75, y: 0.9 }
      ],
      null
    )
    const swipeCall = harmonyRunner(harmony).mock.calls.find((call) => call[1].includes('-m'))
    expect(swipeCall?.[1].slice(0, 4)).toEqual(['-t', KEY, 'shell', 'uinput'])
    expect(swipeCall?.[1].at(-1)).toBe('300')
  })

  it('types quoted text and sends keycodes', async () => {
    const harmony = backend()
    await harmony.type(KEY, 'hello world')
    const typeCall = harmonyRunner(harmony).mock.calls.find(
      (call) => call[1].includes('uiInput') && call[1].includes('text')
    )
    expect(typeCall?.[1]).toEqual([
      '-t',
      KEY,
      'shell',
      'uitest',
      'uiInput',
      'text',
      '"hello world"'
    ])

    await harmony.button(KEY, 'home')
    const buttonCall = harmonyRunner(harmony).mock.calls.find((call) =>
      call[1].includes('keyEvent')
    )
    expect(buttonCall?.[1]).toEqual(['-t', KEY, 'shell', 'uitest', 'uiInput', 'keyEvent', '1'])
  })

  it('passes raw shell commands through as one arg', async () => {
    const harmony = backend({
      generic: () => ({ stdout: 'abc', stderr: '', code: 0 })
    })
    const output = await harmony.exec(KEY, 'ls /data')
    expect(output).toBe('abc')
    const execCall = harmonyRunner(harmony).mock.calls.find(
      (call) => call[0] === SDK.hdc && call[1][2] === 'shell' && call[1][3] === 'ls /data'
    )
    expect(execCall).toBeDefined()
  })
})

describe('HarmonyEmulatorBackend rotate', () => {
  it('issues left rotations and tracks the orientation', async () => {
    let rotations = 0
    const runner = vi.fn<HarmonyCommandRunner>(async (binary, args) => {
      const command = args.join(' ')
      if (binary === SDK.emulator && command === '-list -details') {
        return { stdout: DETAILS, stderr: '', code: 0 }
      }
      if (binary === SDK.emulator && command === '-instance Mate 90 Pro -rotation left') {
        rotations += 1
        return { stdout: '', stderr: '', code: 0 }
      }
      if (binary === SDK.hdc && command === 'list targets') {
        return { stdout: KEY, stderr: '', code: 0 }
      }
      if (binary === SDK.hdc && command.includes('shell snapshot_display')) {
        const width = rotations % 2 === 1 ? 2832 : 1280
        const height = rotations % 2 === 1 ? 1280 : 2832
        return {
          stdout: `success as jpeg, width: ${width}, height: ${height}`,
          stderr: '',
          code: 0
        }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const harmony = track(makeBackend({ runner }), runner)

    await harmony.rotate(KEY, 'landscape_left')
    expect(rotations).toBe(1)

    // Already at landscape_left: no further command.
    await harmony.rotate(KEY, 'landscape_left')
    expect(rotations).toBe(1)

    // Back to portrait takes three left steps.
    await harmony.rotate(KEY, 'portrait')
    expect(rotations).toBe(4)
  })

  it('throws when frames do not reflect the rotation (phone image)', async () => {
    const harmony = backend()
    // Default runner always reports portrait dims despite "successful" rotation.
    await expect(harmony.rotate(KEY, 'landscape_left')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })

  it('rejects rotation for physical devices', async () => {
    const harmony = backend({ details: '[]', targets: () => 'USBSER123' })
    await expect(harmony.rotate('USBSER123', 'landscape_left')).rejects.toMatchObject({
      code: 'emulator_unsupported'
    })
  })
})

describe('HarmonyEmulatorBackend install and launch', () => {
  it('installs a HAP and launches an ability', async () => {
    const harmony = backend()
    await harmony.installApp(KEY, './entry-default-signed.hap')
    const installCall = harmonyRunner(harmony).mock.calls.find((call) =>
      call[1].includes('install')
    )
    expect(installCall?.[1]).toEqual(['-t', KEY, 'install', './entry-default-signed.hap'])

    await harmony.launchApp(KEY, 'com.example.app')
    const launchCall = harmonyRunner(harmony).mock.calls.find((call) => call[1].includes('aa'))
    expect(launchCall?.[1]).toEqual([
      '-t',
      KEY,
      'shell',
      'aa',
      'start',
      '-b',
      'com.example.app',
      '-a',
      'EntryAbility'
    ])
  })
})

describe('HarmonyEmulatorBackend accessibility tree', () => {
  it('dumps and normalizes the uitest layout', async () => {
    const layout = JSON.stringify({
      attributes: { type: 'PhoneWindow', bounds: '[0,0][1280,2832]' },
      children: []
    })
    const readFile = vi.spyOn(await import('node:fs/promises'), 'readFile')
    readFile.mockResolvedValue(layout)

    const harmony = backend({
      generic: (args) =>
        args.includes('dumpLayout')
          ? { stdout: 'DumpLayout saved to:/data/local/tmp/layout.json', stderr: '', code: 0 }
          : { stdout: '', stderr: '', code: 0 }
    })
    const tree = await harmony.accessibilityTree(KEY)
    if (!Array.isArray(tree)) {
      throw new Error('expected accessibility tree array')
    }
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ type: 'PhoneWindow' })
    readFile.mockRestore()
  })
})

describe('HarmonyEmulatorBackend shutdown', () => {
  it('stops a running instance', async () => {
    const harmony = backend()
    await harmony.shutdownDevice(KEY)
    expect(harmonyRunner(harmony)).toHaveBeenCalledWith(SDK.emulator, ['-stop', 'Mate 90 Pro'])
  })

  it('throws when the stop command fails', async () => {
    const harmony = backend({
      generic: () => ({ stdout: '', stderr: 'denied', code: 1 })
    })
    await expect(harmony.shutdownDevice(KEY)).rejects.toMatchObject({ code: 'emulator_error' })
  })

  it('rejects shutdown for physical devices', async () => {
    const harmony = backend({ details: '[]', targets: () => 'USBSER123' })
    await expect(harmony.shutdownDevice('USBSER123')).rejects.toMatchObject({
      code: 'emulator_unsupported'
    })
  })
})

// Mock runner registered for the backend by backend()/track, for call assertions.
function harmonyRunner(harmony: HarmonyEmulatorBackend): HarmonyRunnerMock {
  const runner = runnerMocks.get(harmony)
  if (!runner) {
    throw new Error('backend has no tracked runner')
  }
  return runner
}
