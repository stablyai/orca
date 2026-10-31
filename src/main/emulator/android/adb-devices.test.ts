import { describe, expect, it } from 'vitest'
import { parseAdbDevices, parseWmSize, type AndroidAdbDevice } from './adb-devices'

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
})

describe('parseWmSize', () => {
  it('prefers Override size over Physical size when both are present', () => {
    const stdout = 'Physical size: 1080x2340\nOverride size: 720x1560\n'
    expect(parseWmSize(stdout)).toEqual({ width: 720, height: 1560 })
  })

  it('returns null when no size line is present', () => {
    expect(parseWmSize('')).toBeNull()
    expect(parseWmSize('something unrelated\n')).toBeNull()
  })
})
