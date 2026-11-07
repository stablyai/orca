import { describe, expect, it } from 'vitest'
import { parseAdbDevices, parseWmSize } from './adb-devices'

describe('parseAdbDevices', () => {
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
})
