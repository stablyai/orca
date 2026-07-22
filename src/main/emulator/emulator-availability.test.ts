import { describe, expect, it } from 'vitest'
import { inspectEmulatorAvailability } from './emulator-availability'
import type { EmulatorBridge } from './emulator-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { BackendAvailability } from './backends/emulator-backend'
import type { AndroidSetupStatus, IosSetupStatus } from '../../shared/emulator-setup-types'

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

const IOS_READY: IosSetupStatus = {
  state: 'ready',
  message: 'Ready',
  installedXcodes: [],
  devices: [DEVICE]
}

const IOS_MISSING: IosSetupStatus = {
  state: 'xcode-missing',
  message: 'Full Xcode is not installed.',
  installedXcodes: [],
  devices: []
}

const ANDROID_MISSING: AndroidSetupStatus = {
  state: 'sdk-missing',
  message: NO_ANDROID.message,
  configuredPath: false,
  studioInstalled: false,
  components: { platformTools: false, emulator: false, systemImages: false }
}

function inspect(bridge: EmulatorBridge, ios: IosSetupStatus = IOS_READY) {
  return inspectEmulatorAvailability(bridge, {
    inspectIos: async () => ios,
    inspectAndroid: (backend) => ({
      ...ANDROID_MISSING,
      state: backend.available ? 'ready' : 'sdk-missing',
      message: backend.message,
      sdkPath: backend.sdkPath
    })
  })
}

describe('inspectEmulatorAvailability', () => {
  it('falls back to the Android setup message when no backend is available', async () => {
    const result = await inspect(fakeBridge({ supported: false }), IOS_MISSING)
    expect(result.available).toBe(false)
    expect(result.message).toMatch(/Android SDK/)
    expect(result.devices).toEqual([])
  })

  it('reports ready when iOS simulators exist and serve-sim is available', async () => {
    const result = await inspect(
      fakeBridge({ supported: true, listSimulators: async () => [DEVICE] })
    )
    expect(result.available).toBe(true)
    expect(result.message).toBe('Ready')
    expect(result.devices).toEqual([DEVICE])
  })

  it('reports ready with Android devices when the iOS backend is unsupported', async () => {
    const result = await inspect(
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

  it('does not report Android ready until the setup probe verifies every component', async () => {
    const result = await inspectEmulatorAvailability(
      fakeBridge({
        supported: false,
        android: {
          available: true,
          message: 'Ready',
          sdkPath: '/sdk',
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
      }),
      {
        inspectIos: async () => IOS_MISSING,
        inspectAndroid: () => ({
          ...ANDROID_MISSING,
          state: 'system-image-missing',
          message: 'Install an Android system image.',
          sdkPath: '/sdk'
        })
      }
    )
    expect(result.available).toBe(false)
    expect(result.devices).toEqual([])
    expect(result.android.state).toBe('system-image-missing')
  })

  it('flags simctl when no simulators are installed', async () => {
    const result = await inspect(fakeBridge({ supported: true }), {
      ...IOS_READY,
      state: 'simulator-runtime-missing',
      message: 'No compatible iOS Simulator runtime is installed.',
      devices: []
    })
    expect(result.available).toBe(false)
    expect(result.simctl.ok).toBe(false)
    expect(result.simctl.message).toMatch(/No compatible iOS Simulator runtime/)
  })

  it('flags serve-sim when its check throws', async () => {
    const result = await inspect(
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
    const result = await inspect(fakeBridge({ supported: true }), {
      ...IOS_READY,
      state: 'error',
      message: 'xcrun exploded',
      devices: []
    })
    expect(result.available).toBe(false)
    expect(result.simctl.ok).toBe(false)
    expect(result.simctl.message).toBe('xcrun exploded')
  })
})
