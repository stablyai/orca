import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { AndroidEmulatorBackend } from './android-emulator-backend'
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
