import { describe, expect, it, vi } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import {
  findRunningAvdSerial,
  listAndroidDevices,
  mergeAndroidDevices
} from './android-device-inventory'
import { parseAdbDevices } from './adb-devices'

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

function runner(handler: (binary: string, joinedArgs: string) => string): AndroidCommandRunner {
  return (async (binary: string, args: readonly string[]) =>
    ok(handler(binary, args.join(' ')))) as unknown as AndroidCommandRunner
}

describe('mergeAndroidDevices', () => {
  it('labels running emulators by AVD name and lists unbooted AVDs as shutdown', () => {
    const running = parseAdbDevices('List of devices attached\nemulator-5554\tdevice model:Pixel_7')
    const devices = mergeAndroidDevices(
      running,
      ['Pixel_7', 'Pixel_Tablet'],
      new Map([['emulator-5554', 'Pixel_7']])
    )
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

  it('falls back to the model then serial for unnamed physical devices', () => {
    const running = parseAdbDevices('List of devices attached\nABC123\tdevice model:Pixel_8')
    const devices = mergeAndroidDevices(running, [], new Map())
    expect(devices[0]).toMatchObject({ id: 'ABC123', name: 'Pixel_8', detail: 'device' })
  })
})

describe('listAndroidDevices', () => {
  it('queries adb + emulator and resolves running AVD names', async () => {
    const fake = vi.fn(
      runner((binary, a) => {
        if (binary === SDK.adb && a === 'devices -l') {
          return 'List of devices attached\nemulator-5554\tdevice'
        }
        if (binary === SDK.avdTools?.emulator && a === '-list-avds') {
          return 'Pixel_7'
        }
        if (binary === SDK.adb && a === '-s emulator-5554 emu avd name') {
          return 'Pixel_7\nOK'
        }
        return ''
      })
    )
    const devices = await listAndroidDevices(fake as unknown as AndroidCommandRunner, SDK)
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ id: 'emulator-5554', name: 'Pixel_7', state: 'booted' })
  })

  it('returns connected devices without invoking the emulator binary when avdTools is null', async () => {
    const fake = vi.fn(
      runner((binary, a) => {
        if (binary === SDK_NO_AVD_TOOLS.adb && a === 'devices -l') {
          return 'List of devices attached\n192.168.1.5:5555\tdevice model:Pixel_7'
        }
        return ''
      })
    )
    const devices = await listAndroidDevices(
      fake as unknown as AndroidCommandRunner,
      SDK_NO_AVD_TOOLS
    )
    expect(devices).toEqual([
      {
        backend: 'android',
        id: '192.168.1.5:5555',
        name: 'Pixel_7',
        state: 'booted',
        detail: 'device',
        isAvailable: true
      }
    ])
    // No call should ever target an emulator binary path: only the mandatory adb
    // binary may be invoked when the SDK has no AVD tooling.
    for (const call of fake.mock.calls) {
      expect(call[0]).toBe(SDK_NO_AVD_TOOLS.adb)
    }
  })
})

describe('findRunningAvdSerial', () => {
  it('returns the serial whose AVD name matches', async () => {
    const fake = runner((binary, a) =>
      binary === SDK.adb && a === '-s emulator-5554 emu avd name' ? 'Pixel_7\nOK' : ''
    )
    const running = parseAdbDevices('List of devices attached\nemulator-5554\tdevice')
    expect(await findRunningAvdSerial(fake, SDK, 'Pixel_7', running)).toBe('emulator-5554')
    expect(await findRunningAvdSerial(fake, SDK, 'Other', running)).toBeNull()
  })
})
