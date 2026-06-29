import { describe, expect, it } from 'vitest'
import { inspectEmulatorAvailability } from './emulator-availability'
import type { EmulatorBridge } from './emulator-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { BackendAvailability } from './backends/emulator-backend'

type FakeBridgeOverrides = {
  supported?: boolean
  listSimulators?: () => Promise<SimulatorDevice[]>
  checkServeSimAvailable?: () => Promise<void>
  android?: BackendAvailability
}

const NO_ANDROID: BackendAvailability = {
  available: false,
  devices: [],
  message: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'
}

// A minimal stand-in exposing only what inspectEmulatorAvailability touches: the
// registered backends (iOS host gate + Android checkAvailability) and the iOS
// passthroughs.
function fakeBridge(overrides: FakeBridgeOverrides = {}): EmulatorBridge {
  const android = overrides.android ?? NO_ANDROID
  return {
    listBackends: () => [
      { kind: 'ios', isSupportedOnHost: () => overrides.supported ?? true },
      {
        kind: 'android',
        isSupportedOnHost: () => android.available,
        checkAvailability: async () => android
      }
    ],
    listSimulators: overrides.listSimulators ?? (async () => []),
    checkServeSimAvailable: overrides.checkServeSimAvailable ?? (async () => {})
  } as unknown as EmulatorBridge
}

const DEVICE: SimulatorDevice = {
  name: 'iPhone 17 Pro',
  udid: 'udid-1',
  state: 'Booted',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0'
}

describe('inspectEmulatorAvailability', () => {
  it('falls back to the Android setup message when no backend is available', async () => {
    const result = await inspectEmulatorAvailability(fakeBridge({ supported: false }))
    expect(result.available).toBe(false)
    expect(result.message).toMatch(/Android SDK/)
    expect(result.devices).toEqual([])
  })

  it('reports ready when iOS simulators exist and serve-sim is available', async () => {
    const result = await inspectEmulatorAvailability(
      fakeBridge({ supported: true, listSimulators: async () => [DEVICE] })
    )
    expect(result.available).toBe(true)
    expect(result.message).toBe('Ready')
    expect(result.devices).toEqual([DEVICE])
  })

  it('reports ready with Android devices when the iOS backend is unsupported', async () => {
    const result = await inspectEmulatorAvailability(
      fakeBridge({
        supported: false,
        android: {
          available: true,
          message: 'Ready',
          devices: [
            {
              backend: 'android',
              id: 'emulator-5554',
              name: 'Pixel_7',
              state: 'booted',
              isAvailable: true
            }
          ]
        }
      })
    )
    expect(result.available).toBe(true)
    expect(result.message).toBe('Ready')
    expect(result.devices).toEqual([
      {
        name: 'Pixel_7',
        udid: 'emulator-5554',
        state: 'Booted',
        runtime: 'Android',
        isAvailable: true
      }
    ])
  })

  it('flags simctl when no simulators are installed', async () => {
    const result = await inspectEmulatorAvailability(
      fakeBridge({ supported: true, listSimulators: async () => [] })
    )
    expect(result.available).toBe(false)
    expect(result.simctl.ok).toBe(false)
    expect(result.simctl.message).toMatch(/No iOS simulators/)
  })

  it('flags serve-sim when its check throws', async () => {
    const result = await inspectEmulatorAvailability(
      fakeBridge({
        supported: true,
        listSimulators: async () => [DEVICE],
        checkServeSimAvailable: async () => {
          throw new Error('serve-sim missing')
        }
      })
    )
    expect(result.available).toBe(false)
    expect(result.serveSim.ok).toBe(false)
    expect(result.serveSim.message).toBe('serve-sim missing')
  })

  it('flags simctl when listing simulators throws', async () => {
    const result = await inspectEmulatorAvailability(
      fakeBridge({
        supported: true,
        listSimulators: async () => {
          throw new Error('xcrun exploded')
        }
      })
    )
    expect(result.available).toBe(false)
    expect(result.simctl.ok).toBe(false)
    expect(result.simctl.message).toBe('xcrun exploded')
  })
})
