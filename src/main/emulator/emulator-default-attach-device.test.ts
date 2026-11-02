import { describe, expect, it } from 'vitest'
import type { EmulatorDevice } from './backends/emulator-backend'
import { resolveDefaultAttachDevice } from './emulator-default-attach-device'

describe('resolveDefaultAttachDevice', () => {
  it('prefers a booted Android emulator over a shut-down iPhone', async () => {
    const devices: EmulatorDevice[] = [
      { backend: 'ios', id: 'iphone-1', name: 'iPhone 16', state: 'shutdown', isAvailable: true },
      {
        backend: 'android',
        id: 'emulator-5554',
        name: 'Pixel_8',
        state: 'booted',
        isAvailable: true
      }
    ]
    await expect(resolveDefaultAttachDevice({ listAllDevices: async () => devices })).resolves.toBe(
      'emulator-5554'
    )
  })

  it('keeps the workspace device while it is still booted, ahead of the configured default', async () => {
    const devices: EmulatorDevice[] = [
      { backend: 'ios', id: 'iphone-1', name: 'iPhone 16', state: 'booted', isAvailable: true },
      {
        backend: 'android',
        id: 'emulator-5554',
        name: 'Pixel_8',
        state: 'booted',
        isAvailable: true
      }
    ]
    await expect(
      resolveDefaultAttachDevice(
        { listAllDevices: async () => devices },
        { current: 'emulator-5554', configured: 'iphone-1' }
      )
    ).resolves.toBe('emulator-5554')
  })
})
