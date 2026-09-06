import { describe, expect, it, vi } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidAdbDevice } from './adb-devices'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { inspectAndroidDeviceControlCapabilities } from './android-device-control-capabilities'

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  emulator: '/sdk/emulator',
  avdmanager: '/sdk/avdmanager'
}

const device = (serial = 'emulator-5554', isEmulator = true): AndroidAdbDevice => ({
  serial,
  state: 'device',
  isEmulator
})
const result = (stdout: string, code = 0): AndroidCommandResult => ({
  stdout,
  stderr: '',
  code
})

function probeRunner(responses: Record<string, AndroidCommandResult | Error>): {
  runner: AndroidCommandRunner
  calls: ReturnType<typeof vi.fn>
} {
  const calls = vi.fn()
  const runner: AndroidCommandRunner = async (_binary, args, options) => {
    calls(args, options)
    const response = responses[args.join(' ')]
    if (response instanceof Error) {
      throw response
    }
    return response ?? result('')
  }
  return { runner, calls }
}

describe('inspectAndroidDeviceControlCapabilities', () => {
  it('detects phone, physical shutdown, and multi-state foldable capabilities', async () => {
    const { runner, calls } = probeRunner({
      '-s emulator-5554 shell getprop ro.build.characteristics': result('default,phone'),
      '-s emulator-5554 shell getprop ro.build.version.sdk': result('35'),
      '-s emulator-5554 shell cmd device_state print-states-simple': result('0: CLOSED\n1: OPEN')
    })
    const capabilities = await inspectAndroidDeviceControlCapabilities(runner, SDK, device())

    expect(capabilities).toEqual({
      shutdown: true,
      power: true,
      volume: true,
      overview: true,
      foldable: true,
      wearButton1: false,
      wearButton2: false
    })
    expect(calls).toHaveBeenCalledTimes(3)
    expect(calls.mock.calls.every(([, options]) => options?.timeoutMs === 2_000)).toBe(true)
  })
  it.each([
    ['27', false],
    ['28', true],
    ['29', true],
    ['30', true],
    ['35', true]
  ] as const)('applies Wear API gates for %s', async (api, button1) => {
    const { runner } = probeRunner({
      '-s emulator-5554 shell getprop ro.build.characteristics': result('default,watch,phone'),
      '-s emulator-5554 shell getprop ro.build.version.sdk': result(api),
      '-s emulator-5554 shell cmd device_state print-states-simple': result('0')
    })
    const capabilities = await inspectAndroidDeviceControlCapabilities(runner, SDK, device())
    expect(capabilities.power).toBe(api === '27')
    expect(capabilities.volume).toBe(false)
    expect(capabilities.overview).toBe(false)
    expect(capabilities.wearButton1).toBe(button1)
    expect(capabilities.wearButton2).toBe(Number(api) >= 30)
  })

  it('uses common phone defaults when characteristics fail and hides fold on state failure', async () => {
    const { runner } = probeRunner({
      '-s emulator-5554 shell getprop ro.build.characteristics': result('', 1),
      '-s emulator-5554 shell getprop ro.build.version.sdk': result('35'),
      '-s emulator-5554 shell cmd device_state print-states-simple': result('', 1)
    })
    await expect(
      inspectAndroidDeviceControlCapabilities(runner, SDK, device())
    ).resolves.toMatchObject({
      shutdown: true,
      power: true,
      volume: true,
      overview: true,
      foldable: false,
      wearButton1: false,
      wearButton2: false
    })
  })

  it('hides Wear controls and power when the API probe rejects', async () => {
    const { runner } = probeRunner({
      '-s emulator-5554 shell getprop ro.build.characteristics': result('watch'),
      '-s emulator-5554 shell getprop ro.build.version.sdk': new Error('timeout'),
      '-s emulator-5554 shell cmd device_state print-states-simple': result('0')
    })
    await expect(
      inspectAndroidDeviceControlCapabilities(runner, SDK, device())
    ).resolves.toMatchObject({
      power: false,
      volume: false,
      overview: false,
      wearButton1: false,
      wearButton2: false
    })
  })
})
