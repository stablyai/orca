import { describe, expect, it } from 'vitest'
import {
  resolveEmulatorOpeningPreference,
  rememberEmulatorDevice
} from './emulator-opening-preference'
import type { EmulatorDevice } from './backends/emulator-backend'
const devices: EmulatorDevice[] = [
  { backend: 'ios', id: 'iphone', name: 'iPhone', state: 'booted', isAvailable: true },
  {
    backend: 'android',
    id: 'emulator-5558',
    name: 'Pixel9_API36',
    detail: 'emulator',
    state: 'booted',
    isAvailable: true
  }
]
describe('emulator opening preferences', () => {
  it('asks on first use instead of choosing a running iPhone', () => {
    expect(resolveEmulatorOpeningPreference({}, devices)).toEqual({
      selectionRequired: 'first-use'
    })
  })
  it('resolves a remembered AVD after its adb serial changes', () => {
    const recent = rememberEmulatorDevice(devices[1], [])
    expect(recent[0].id).toBe('Pixel9_API36')
    expect(
      resolveEmulatorOpeningPreference({ mobileEmulatorRecentDevices: recent }, devices)
    ).toEqual({ device: 'emulator-5558' })
    expect(
      resolveEmulatorOpeningPreference({ mobileEmulatorRecentDevices: recent }, devices.slice(0, 1))
    ).toEqual({ selectionRequired: 'missing' })
  })
  it('preserves a legacy fixed device, but respects an explicit ask or last-used mode', () => {
    const settings = {
      mobileEmulatorDefaultDeviceUdid: 'iphone',
      mobileEmulatorRecentDevices: rememberEmulatorDevice(devices[1], [])
    }
    expect(resolveEmulatorOpeningPreference(settings, devices)).toEqual({ device: 'iphone' })
    expect(
      resolveEmulatorOpeningPreference({ ...settings, mobileEmulatorOpeningMode: 'ask' }, devices)
    ).toEqual({ selectionRequired: 'ask' })
    expect(
      resolveEmulatorOpeningPreference(
        { ...settings, mobileEmulatorOpeningMode: 'last-used' },
        devices
      )
    ).toEqual({ device: 'emulator-5558' })
  })
  it('does not replace a missing or unavailable preference with another platform', () => {
    expect(
      resolveEmulatorOpeningPreference({ mobileEmulatorDefaultDeviceUdid: 'removed' }, devices)
    ).toEqual({ selectionRequired: 'missing' })
    expect(
      resolveEmulatorOpeningPreference({ mobileEmulatorDefaultDeviceUdid: 'iphone' }, [
        { ...devices[0], isAvailable: false }
      ])
    ).toEqual({ selectionRequired: 'unavailable' })
  })
  it('keeps physical serials distinct from AVD names and bounds recent preferences', () => {
    const physical: EmulatorDevice = {
      ...devices[1],
      id: 'USB-123',
      name: 'Pixel9_API36',
      detail: 'device'
    }
    const recent = rememberEmulatorDevice(physical, rememberEmulatorDevice(devices[1], []))
    expect(recent.map((item) => item.id)).toEqual(['USB-123', 'Pixel9_API36'])
    expect(
      resolveEmulatorOpeningPreference({ mobileEmulatorRecentDevices: recent }, devices)
    ).toEqual({ selectionRequired: 'missing' })
    let history = recent
    for (let i = 0; i < 25; i++) {
      history = rememberEmulatorDevice({ ...physical, id: `USB-${i}` }, history)
    }
    expect(history).toHaveLength(20)
  })
})
