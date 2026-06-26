import { describe, expect, it } from 'vitest'
import { inspectEmulatorAvailability } from './emulator-availability'
import type { EmulatorBridge } from './emulator-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'

type FakeBridgeOverrides = {
  supported?: boolean
  listSimulators?: () => Promise<SimulatorDevice[]>
  checkServeSimAvailable?: () => Promise<void>
}

// A minimal stand-in exposing only what inspectEmulatorAvailability touches, so
// the iOS host gate is exercised without mocking os.platform.
function fakeBridge(overrides: FakeBridgeOverrides = {}): EmulatorBridge {
  return {
    listBackends: () => [{ kind: 'ios', isSupportedOnHost: () => overrides.supported ?? true }],
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
  it('reports unavailable when the iOS backend does not support the host', async () => {
    const result = await inspectEmulatorAvailability(fakeBridge({ supported: false }))
    expect(result.available).toBe(false)
    expect(result.message).toMatch(/macOS/)
    expect(result.simctl.ok).toBe(false)
    expect(result.serveSim.ok).toBe(false)
    expect(result.devices).toEqual([])
  })

  it('reports ready when devices exist and serve-sim is available', async () => {
    const result = await inspectEmulatorAvailability(
      fakeBridge({ supported: true, listSimulators: async () => [DEVICE] })
    )
    expect(result.available).toBe(true)
    expect(result.message).toBe('Ready')
    expect(result.devices).toEqual([DEVICE])
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
