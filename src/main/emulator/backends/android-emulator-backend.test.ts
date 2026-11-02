import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { AndroidEmulatorBackend } from './android-emulator-backend'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import type { AndroidCommandResult, AndroidCommandRunner } from '../android/android-command-runner'
import type { AndroidSdkPaths } from '../android/android-sdk-discovery'

// AVD boot spawns directly, bypassing the injected command runner.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })) }
})

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  emulator: '/sdk/emulator'
}

const ok = (stdout: string): AndroidCommandResult => ({ stdout, stderr: '', code: 0 })

const RUNNING_ADB =
  'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64 model:Pixel_7 device:emu64a'

function defaultRunner(): ReturnType<typeof vi.fn> {
  return vi.fn(async (binary: string, args: readonly string[]) => {
    const a = args.join(' ')
    if (binary === SDK.adb && a === 'devices -l') {
      return ok(RUNNING_ADB)
    }
    if (binary === SDK.emulator && a === '-list-avds') {
      return ok('Pixel_7\nPixel_Tablet')
    }
    if (binary === SDK.adb && a === '-s emulator-5554 emu avd name') {
      return ok('Pixel_7\nOK')
    }
    if (binary === SDK.adb && a === '-s emulator-5554 shell wm size') {
      return ok('Physical size: 1080x2400')
    }
    return ok('')
  })
}

function backend(
  runner: ReturnType<typeof vi.fn>,
  sleep: (ms: number) => Promise<void> = async () => {}
): AndroidEmulatorBackend {
  return new AndroidEmulatorBackend({
    runner: runner as unknown as AndroidCommandRunner,
    sdk: SDK,
    sleep
  })
}

describe('AndroidEmulatorBackend', () => {
  let runner: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runner = defaultRunner()
  })

  it('declares android kind, h264 codec, and full capabilities', () => {
    const android = backend(runner)
    expect(android.kind).toBe('android')
    expect(android.streamCodec).toBe('h264')
    expect(android.capabilities).toEqual({
      install: true,
      launch: true,
      permissions: true,
      accessibilityTree: true,
      logcat: true
    })
  })

  it('is unsupported when no SDK is discovered', () => {
    const android = new AndroidEmulatorBackend({
      runner: runner as unknown as AndroidCommandRunner,
      sdk: null
    })
    expect(android.isSupportedOnHost()).toBe(false)
  })

  it('merges running devices and shutdown AVDs', async () => {
    const devices = await backend(runner).listDevices()
    expect(devices).toEqual([
      {
        backend: 'android',
        id: 'emulator-5554',
        name: 'Pixel_7',
        state: 'booted',
        detail: 'emulator',
        isAvailable: true
      },
      {
        backend: 'android',
        id: 'Pixel_Tablet',
        name: 'Pixel_Tablet',
        state: 'shutdown',
        detail: 'avd',
        isAvailable: true
      }
    ])
  })

  it('owns devices by serial or AVD name', async () => {
    const android = backend(runner)
    expect(await android.ownsDevice('emulator-5554')).toBe(true)
    expect(await android.ownsDevice('Pixel_Tablet')).toBe(true)
    expect(await android.ownsDevice('nope')).toBe(false)
  })

  it('resolves a running AVD name to its serial and rejects unbooted devices', async () => {
    const android = backend(runner)
    expect(await android.resolveDeviceId('emulator-5554')).toBe('emulator-5554')
    expect(await android.resolveDeviceId('Pixel_7')).toBe('emulator-5554')
    await expect(android.resolveDeviceId('Pixel_Tablet')).rejects.toMatchObject({
      code: 'emulator_device_not_found'
    })
  })

  it('taps using device pixels from the live screen size', async () => {
    await backend(runner).tap('emulator-5554', 0.5, 0.5)
    expect(runner).toHaveBeenCalledWith(SDK.adb, [
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'tap',
      '540',
      '1200'
    ])
  })

  it('types text with spaces encoded and presses hardware buttons by keycode', async () => {
    const android = backend(runner)
    await android.type('emulator-5554', 'hi there')
    await android.button('emulator-5554', 'back')
    expect(runner).toHaveBeenCalledWith(SDK.adb, [
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'text',
      "'hi%sthere'"
    ])
    expect(runner).toHaveBeenCalledWith(SDK.adb, [
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'keyevent',
      '4'
    ])
  })

  describe('with a live scrcpy session', () => {
    const sent: Buffer[] = []
    const sendControl = vi.fn((message: Buffer) => {
      sent.push(message)
      return true
    })

    beforeEach(() => {
      sent.length = 0
      sendControl.mockClear()
      scrcpyVideoRegistry.register('emulator-5554', () => {})
      scrcpyVideoRegistry.attachControl('emulator-5554', {
        videoSize: () => ({ width: 600, height: 1280 }),
        sendControl
      })
    })

    afterEach(() => {
      scrcpyVideoRegistry.stop('emulator-5554')
    })

    const touches = (): [number, number, number][] =>
      sent
        .filter((message) => message[0] === 2)
        .map((message) => [message[1], message.readInt32BE(10), message.readInt32BE(14)])

    it('sends input over the control socket in video pixels without adb', async () => {
      const sleep = vi.fn(async () => {})
      const android = new AndroidEmulatorBackend({
        runner: runner as unknown as AndroidCommandRunner,
        sdk: SDK,
        sleep
      })

      await android.tap('emulator-5554', 0.5, 0.5)
      expect(touches()).toEqual([
        [0, 300, 640],
        [1, 300, 640]
      ])
      expect(sent[0].readUInt16BE(18)).toBe(600)
      expect(sent[0].readUInt16BE(20)).toBe(1280)

      sent.length = 0
      await android.gesture(
        'emulator-5554',
        [
          { type: 'begin', x: 0.5, y: 0.75 },
          { type: 'end', x: 0.5, y: 0.25 }
        ],
        null
      )
      const swipe = touches()
      expect(swipe[0]).toEqual([0, 300, 960])
      expect(swipe.at(-1)).toEqual([1, 300, 320])
      expect(swipe.slice(1, -1).every(([action]) => action === 2)).toBe(true)
      expect(sleep.mock.calls.length * 16).toBeGreaterThanOrEqual(300)

      sent.length = 0
      await android.type('emulator-5554', 'héllo wörld')
      await android.button('emulator-5554', 'back')
      expect(sent[0][0]).toBe(1)
      expect(sent[0].subarray(5).toString('utf8')).toBe('héllo wörld')
      expect(
        sent.slice(1).map((message) => [message[0], message[1], message.readInt32BE(2)])
      ).toEqual([
        [0, 0, 4],
        [0, 1, 4]
      ])

      expect(runner).not.toHaveBeenCalled()
    })

    it('finds the session by serial when input names the AVD', async () => {
      await backend(runner).tap('Pixel_7', 0, 0)
      expect(touches()).toEqual([
        [0, 0, 0],
        [1, 0, 0]
      ])
      expect(runner.mock.calls.some(([, args]) => args.includes('input'))).toBe(false)
    })

    it('falls back to adb input once the control socket is gone', async () => {
      sendControl.mockReturnValueOnce(false)
      await backend(runner).tap('emulator-5554', 0.5, 0.5)
      expect(runner).toHaveBeenCalledWith(SDK.adb, [
        '-s',
        'emulator-5554',
        'shell',
        'input',
        'tap',
        '540',
        '1200'
      ])
    })
  })

  it('rotates via user_rotation and forgets the cached screen size', async () => {
    await backend(runner).rotate('emulator-5554', 'landscape_left')
    expect(runner).toHaveBeenCalledWith(SDK.adb, [
      '-s',
      'emulator-5554',
      'shell',
      'settings',
      'put',
      'system',
      'user_rotation',
      '1'
    ])
  })

  it('runs exec as an adb shell command and returns stdout', async () => {
    runner.mockImplementation(async (binary: string, args: readonly string[]) => {
      const a = args.join(' ')
      if (binary === SDK.adb && a === 'devices -l') {
        return ok(RUNNING_ADB)
      }
      if (binary === SDK.adb && a === '-s emulator-5554 shell getprop ro.build.version.sdk') {
        return ok('34')
      }
      return ok('')
    })
    const result = await backend(runner).exec('emulator-5554', 'getprop ro.build.version.sdk')
    expect(result).toBe('34')
  })

  it('shuts a device down with adb emu kill', async () => {
    await backend(runner).shutdownDevice('emulator-5554')
    expect(runner).toHaveBeenCalledWith(SDK.adb, ['-s', 'emulator-5554', 'emu', 'kill'])
  })

  it('installs an apk and grants a permission on the resolved device', async () => {
    const android = backend(runner)
    await android.installApp('emulator-5554', '/tmp/app.apk')
    await android.setPermission('emulator-5554', 'grant', 'com.x', 'android.permission.CAMERA')
    expect(runner).toHaveBeenCalledWith(SDK.adb, ['-s', 'emulator-5554', 'install', '/tmp/app.apk'])
    expect(runner).toHaveBeenCalledWith(SDK.adb, [
      '-s',
      'emulator-5554',
      'shell',
      'pm',
      'grant',
      'com.x',
      'android.permission.CAMERA'
    ])
  })

  it('dumps the accessibility tree from the device', async () => {
    runner.mockImplementation(async (binary: string, args: readonly string[]) => {
      const a = args.join(' ')
      if (binary === SDK.adb && a === 'devices -l') {
        return ok(RUNNING_ADB)
      }
      if (binary === SDK.adb && a === '-s emulator-5554 shell cat /sdcard/window_dump.xml') {
        return ok('<hierarchy><node text="Hi"/></hierarchy>')
      }
      return ok('')
    })
    const tree = (await backend(runner).accessibilityTree('emulator-5554')) as {
      children: { text?: string }[]
    }
    expect(tree.children[0]).toMatchObject({ text: 'Hi' })
  })

  it('boots a shutdown AVD once for concurrent callers and waits for its serial', async () => {
    let bootStarted = false
    vi.mocked(spawn).mockImplementation(() => {
      bootStarted = true
      return { on: () => {}, unref: () => {} } as unknown as ReturnType<typeof spawn>
    })
    const bootRunner = vi.fn(async (binary: string, args: readonly string[]) => {
      const a = args.join(' ')
      if (binary === SDK.adb && a === 'devices -l') {
        return ok(
          bootStarted
            ? 'List of devices attached\nemulator-5556\tdevice'
            : 'List of devices attached'
        )
      }
      if (binary === SDK.adb && a === '-s emulator-5556 shell getprop sys.boot_completed') {
        return ok('1')
      }
      if (binary === SDK.adb && a === '-s emulator-5556 emu avd name') {
        return ok('Pixel_Tablet\nOK\n')
      }
      if (binary === SDK.emulator && a === '-list-avds') {
        return ok('Pixel_Tablet')
      }
      return ok('')
    })
    const android = backend(bootRunner)
    const serials = await Promise.all([
      android.ensureBooted('Pixel_Tablet'),
      android.ensureBooted('Pixel_Tablet')
    ])
    expect(serials).toEqual(['emulator-5556', 'emulator-5556'])
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(
      SDK.emulator,
      ['-avd', 'Pixel_Tablet', '-no-window'],
      expect.objectContaining({ windowsHide: true })
    )
  })

  function launchExitsWith(output: string): void {
    vi.mocked(spawn).mockImplementation(() => {
      const child = createFakeSpawnedChild()
      child.stdout.end(output)
      setImmediate(() => child.emit('exit', 1, null))
      return child
    })
  }
  const yieldToExit = () => new Promise<void>((resolve) => setImmediate(resolve))

  it('fails with the emulator output when the AVD exits before booting', async () => {
    launchExitsWith(
      'INFO         | Android emulator version 37.2.12.0\n' +
        'WARNING      | /sdk/system-images/android-35/google_apis/arm64-v8a/ is not a valid directory.\n' +
        'WARNING      | emulator has searched the above paths but found no valid sdk root directory.\n' +
        'FATAL        | Cannot find AVD system path. Please define ANDROID_SDK_ROOT\n\n'
    )
    await expect(backend(runner, yieldToExit).ensureBooted('Pixel_Tablet')).rejects.toThrow(
      'AVD "Pixel_Tablet" stopped before it finished booting: ' +
        'WARNING | /sdk/system-images/android-35/google_apis/arm64-v8a/ is not a valid directory.\n' +
        'WARNING | emulator has searched the above paths but found no valid sdk root directory.\n' +
        'FATAL | Cannot find AVD system path. Please define ANDROID_SDK_ROOT'
    )
  })

  it('waits for an instance booting elsewhere when the launch exits on the AVD lock', async () => {
    // The third listing fails, which must not read as "no instance".
    launchExitsWith(
      'FATAL        | Running multiple emulators with the same AVD is an experimental feature.\n'
    )
    const states = ['offline', 'offline', 'failed', 'device']
    const bootRunner = vi.fn(async (binary: string, args: readonly string[]) => {
      const a = args.join(' ')
      if (binary === SDK.adb && a === 'devices -l') {
        const state = states.shift() ?? 'device'
        return state === 'failed'
          ? { stdout: '', stderr: 'adb server not responding', code: 1 }
          : ok(`List of devices attached\nemulator-5556\t${state}`)
      }
      if (binary === SDK.adb && a === '-s emulator-5556 emu avd name') {
        return ok('Pixel_Tablet\nOK\n')
      }
      if (binary === SDK.adb && a === '-s emulator-5556 shell getprop sys.boot_completed') {
        return ok(states.length === 0 ? '1' : '')
      }
      if (binary === SDK.emulator && a === '-list-avds') {
        return ok('Pixel_Tablet')
      }
      return ok('')
    })
    await expect(backend(bootRunner, yieldToExit).ensureBooted('Pixel_Tablet')).resolves.toBe(
      'emulator-5556'
    )
  })

  it('startSession boots, ensures the jar, returns an h264 session, and tears it down', async () => {
    const close = vi.fn()
    const android = new AndroidEmulatorBackend({
      runner: runner as unknown as AndroidCommandRunner,
      sdk: SDK,
      sleep: async () => {},
      ensureJar: async () => '/cache/scrcpy-server.jar',
      startStreamSession: async ({ serial }) => ({
        info: {
          deviceUdid: serial,
          streamUrl: `scrcpy://${serial}`,
          wsUrl: '',
          streamCodec: 'h264'
        },
        handle: { close }
      })
    })
    const info = await android.startSession('emulator-5554')
    expect(info).toMatchObject({ deviceUdid: 'emulator-5554', streamCodec: 'h264' })
    await android.stopHelperForDevice('emulator-5554', { includeOrphaned: true })
    await android.stopHelperForDevice('emulator-5554', { includeOrphaned: true })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('preserves all unowned forwards when stopping without a live session', async () => {
    // adb forward listing/removal is server-wide, so unowned forwards must survive.
    const forwards = [
      'emulator-5554 tcp:41234 localabstract:scrcpy_1a2b3c4d',
      'emulator-5554 tcp:8081 tcp:8081',
      'emulator-5556 tcp:41235 localabstract:scrcpy_5e6f7a8b',
      'R58M12345 tcp:9222 localabstract:chrome_devtools_remote'
    ]
    const before = [...forwards]
    runner.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary === SDK.adb && args.join(' ') === 'devices -l') {
        return ok(RUNNING_ADB)
      }
      const [flag, local] = args.includes('forward') ? args.slice(args.indexOf('forward') + 1) : []
      if (flag === '--list') {
        return ok(`${forwards.join('\n')}\n\n`)
      }
      if (flag === '--remove-all') {
        forwards.length = 0
      } else if (flag === '--remove') {
        const index = forwards.findIndex((line) => line.split(' ')[1] === local)
        if (index !== -1) {
          forwards.splice(index, 1)
        }
      }
      return ok('')
    })

    const android = backend(runner)
    await android.stopHelperForDevice('emulator-5554', { includeOrphaned: true })
    await android.stopHelperForDevice('emulator-5554', { includeOrphaned: true })

    expect(forwards).toEqual(before)
  })
})
