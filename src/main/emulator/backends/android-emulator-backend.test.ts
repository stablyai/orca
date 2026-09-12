import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { AndroidEmulatorBackend } from './android-emulator-backend'
import type { AndroidCommandResult, AndroidCommandRunner } from '../android/android-command-runner'
import type { AndroidSdkPaths } from '../android/android-sdk-discovery'

// The AVD boot spawns the emulator detached (not via the command runner).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })) }
})

// scrcpy-server-download (an ensureJar transitive import) reaches into
// `electron.app`; these are pure adb/backend-logic tests with no Electron
// runtime, so stub it like sibling main-process test files do.
vi.mock('electron', () => ({ app: { getPath: () => '/mock-userdata' } }))

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  avdTools: { emulator: '/sdk/emulator', avdmanager: '/sdk/avdmanager' }
}

const SDK_NO_AVD_TOOLS: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  avdTools: null
}

const ok = (stdout: string): AndroidCommandResult => ({ stdout, stderr: '', code: 0 })

const RUNNING_ADB =
  'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64 model:Pixel_7 device:emu64a'

// Default runner answering the standard discovery/query calls for a single
// booted Pixel_7 emulator plus a shutdown Pixel_Tablet AVD.
function defaultRunner(): ReturnType<typeof vi.fn> {
  return vi.fn(async (binary: string, args: readonly string[]) => {
    const a = args.join(' ')
    if (binary === SDK.adb && a === 'devices -l') {
      return ok(RUNNING_ADB)
    }
    if (binary === SDK.avdTools?.emulator && a === '-list-avds') {
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

function backend(runner: ReturnType<typeof vi.fn>): AndroidEmulatorBackend {
  return new AndroidEmulatorBackend({
    runner: runner as unknown as AndroidCommandRunner,
    sdk: SDK,
    sleep: async () => {}
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

  it('reports a disconnected network serial as not-connected, not "boot it"', async () => {
    const android = backend(runner)
    await expect(android.resolveDeviceId('127.0.0.1:5555')).rejects.toMatchObject({
      code: 'emulator_adb_not_connected',
      message: expect.stringContaining('Settings > Mobile Emulator')
    })
    // Every device verb funnels through resolveDeviceId, so input verbs get the
    // same guidance instead of emulator_device_not_found.
    await expect(android.tap('cloud-phone.internal:5555', 0.5, 0.5)).rejects.toMatchObject({
      code: 'emulator_adb_not_connected'
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
      'hi%sthere'
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

  it('never sends emu kill for a TCP or USB serial (clears state and returns)', async () => {
    const networkRunner = vi.fn(async (binary: string, args: readonly string[]) => {
      const a = args.join(' ')
      if (binary === SDK.adb && a === 'devices -l') {
        return ok(
          'List of devices attached\n127.0.0.1:5555\tdevice\ncloud.internal:5555\tdevice\nR58N123ABC\tdevice'
        )
      }
      return ok('')
    })
    const android = backend(networkRunner)
    await android.shutdownDevice('127.0.0.1:5555')
    await android.shutdownDevice('cloud.internal:5555')
    await android.shutdownDevice('R58N123ABC')
    for (const call of networkRunner.mock.calls) {
      expect(call[1].join(' ')).not.toContain('emu kill')
    }
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

  it('boots a shutdown AVD and waits for the new booted serial', async () => {
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
      if (binary === SDK.avdTools?.emulator && a === '-list-avds') {
        return ok('Pixel_Tablet')
      }
      return ok('')
    })
    const serial = await backend(bootRunner).ensureBooted('Pixel_Tablet')
    expect(serial).toBe('emulator-5556')
    expect(spawn).toHaveBeenCalledWith(
      SDK.avdTools?.emulator,
      ['-avd', 'Pixel_Tablet', '-no-window'],
      expect.objectContaining({ windowsHide: true })
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
    await android.stopHelperForDevice('emulator-5554')
    expect(close).toHaveBeenCalledTimes(1)
  })

  describe('checkAvailability', () => {
    it('is available with devices present regardless of avdTools', async () => {
      const android = backend(runner)
      const availability = await android.checkAvailability()
      expect(availability).toMatchObject({ available: true, message: 'Ready' })
    })

    it('suggests Android Studio when no devices are found and avdTools exist', async () => {
      const emptyRunner = vi.fn(async (binary: string, args: readonly string[]) => {
        const a = args.join(' ')
        if (binary === SDK.adb && a === 'devices -l') {
          return ok('List of devices attached')
        }
        if (binary === SDK.avdTools?.emulator && a === '-list-avds') {
          return ok('')
        }
        return ok('')
      })
      const android = backend(emptyRunner)
      const availability = await android.checkAvailability()
      expect(availability).toMatchObject({
        available: false,
        message: 'No Android devices or AVDs found. Create one in Android Studio.'
      })
    })

    it('suggests connecting a device (not Android Studio) when adb exists but avdTools is null', async () => {
      const emptyRunner = vi.fn(async (binary: string, args: readonly string[]) => {
        const a = args.join(' ')
        if (binary === SDK_NO_AVD_TOOLS.adb && a === 'devices -l') {
          return ok('List of devices attached')
        }
        return ok('')
      })
      const android = new AndroidEmulatorBackend({
        runner: emptyRunner as unknown as AndroidCommandRunner,
        sdk: SDK_NO_AVD_TOOLS,
        sleep: async () => {}
      })
      const availability = await android.checkAvailability()
      expect(availability.available).toBe(false)
      expect(availability.message).toContain('adb')
      expect(availability.message).toContain('Settings > Mobile Emulator')
      expect(availability.message).not.toContain('Android Studio')
      // Never invoke the emulator binary when avdTools is null.
      for (const call of emptyRunner.mock.calls) {
        expect(call[0]).toBe(SDK_NO_AVD_TOOLS.adb)
      }
    })

    it('is available with connected devices and no emulator invocation when avdTools is null', async () => {
      const deviceRunner = vi.fn(async (binary: string, args: readonly string[]) => {
        const a = args.join(' ')
        if (binary === SDK_NO_AVD_TOOLS.adb && a === 'devices -l') {
          return ok('List of devices attached\n192.168.1.5:5555\tdevice model:Pixel_7')
        }
        return ok('')
      })
      const android = new AndroidEmulatorBackend({
        runner: deviceRunner as unknown as AndroidCommandRunner,
        sdk: SDK_NO_AVD_TOOLS,
        sleep: async () => {}
      })
      const availability = await android.checkAvailability()
      expect(availability).toMatchObject({ available: true, message: 'Ready' })
      for (const call of deviceRunner.mock.calls) {
        expect(call[0]).toBe(SDK_NO_AVD_TOOLS.adb)
      }
    })
  })
})
