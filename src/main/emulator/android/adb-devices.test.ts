import { describe, expect, it } from 'vitest'
import {
  adbDevicesArgs,
  adbShellArgs,
  bootCompletedArgs,
  isBootCompleted,
  parseAdbDevices,
  parseWmSize,
  wmSizeArgs,
  type AndroidAdbDevice
} from './adb-devices'

describe('parseAdbDevices', () => {
  it('parses a mixed list of emulator and physical devices', () => {
    const stdout = [
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emulator64_x86_64_arm64 transport_id:1',
      '0123456789ABCDEF       device usb:1-1.4 product:bullhead model:Nexus_5X device:bullhead transport_id:2',
      'FEDCBA9876543210       offline',
      'ABCDEF0123456789       unauthorized',
      ''
    ].join('\n')

    expect(parseAdbDevices(stdout)).toEqual<AndroidAdbDevice[]>([
      {
        serial: 'emulator-5554',
        state: 'device',
        isEmulator: true,
        model: 'sdk_gphone64_x86_64',
        product: 'sdk_gphone64_x86_64'
      },
      {
        serial: '0123456789ABCDEF',
        state: 'device',
        isEmulator: false,
        model: 'Nexus_5X',
        product: 'bullhead'
      },
      { serial: 'FEDCBA9876543210', state: 'offline', isEmulator: false },
      { serial: 'ABCDEF0123456789', state: 'unauthorized', isEmulator: false }
    ])
  })

  it('returns an empty array for header-only output', () => {
    expect(parseAdbDevices('List of devices attached\n')).toEqual([])
  })

  it('returns an empty array for empty output', () => {
    expect(parseAdbDevices('')).toEqual([])
  })

  it('parses the two-word "no permissions" state', () => {
    const device = parseAdbDevices(
      'List of devices attached\n????????????           no permissions\n'
    )[0]
    expect(device).toEqual({
      serial: '????????????',
      state: 'no permissions',
      isEmulator: false
    })
  })

  it('omits model/product when the device line has no -l tokens', () => {
    const [device] = parseAdbDevices('List of devices attached\nemulator-5556          device\n')
    expect(device).toEqual({ serial: 'emulator-5556', state: 'device', isEmulator: true })
    expect(device.model).toBeUndefined()
    expect(device.product).toBeUndefined()
  })
})

describe('parseWmSize', () => {
  it('parses a Physical size line', () => {
    expect(parseWmSize('Physical size: 1080x2340\n')).toEqual({ width: 1080, height: 2340 })
  })

  it('prefers Override size over Physical size when both are present', () => {
    const stdout = 'Physical size: 1080x2340\nOverride size: 720x1560\n'
    expect(parseWmSize(stdout)).toEqual({ width: 720, height: 1560 })
  })

  it('parses an Override size line on its own', () => {
    expect(parseWmSize('Override size: 540x1170')).toEqual({ width: 540, height: 1170 })
  })

  it('returns null when no size line is present', () => {
    expect(parseWmSize('')).toBeNull()
    expect(parseWmSize('something unrelated\n')).toBeNull()
  })
})

describe('isBootCompleted', () => {
  it('returns true for a trimmed "1"', () => {
    expect(isBootCompleted('1\n')).toBe(true)
    expect(isBootCompleted('  1  ')).toBe(true)
  })

  it('returns false for "0"', () => {
    expect(isBootCompleted('0')).toBe(false)
  })

  it('returns false for empty output', () => {
    expect(isBootCompleted('')).toBe(false)
  })
})

describe('adb argument builders', () => {
  it('exposes the device-list args', () => {
    expect(adbDevicesArgs).toEqual(['devices', '-l'])
  })

  it('builds shell args with the serial and command', () => {
    expect(adbShellArgs('emulator-5554', ['wm', 'size'])).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'wm',
      'size'
    ])
  })

  it('builds wm size args', () => {
    expect(wmSizeArgs('emulator-5554')).toEqual(['-s', 'emulator-5554', 'shell', 'wm', 'size'])
  })

  it('builds boot-completed args', () => {
    expect(bootCompletedArgs('emulator-5554')).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'getprop',
      'sys.boot_completed'
    ])
  })
})
