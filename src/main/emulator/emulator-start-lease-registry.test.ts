import { describe, expect, it, vi } from 'vitest'
import type { EmulatorBackend } from './backends/emulator-backend'
import { EmulatorStartLeaseRegistry } from './emulator-start-lease-registry'
import type { EmulatorSessionInfo } from './emulator-types'

function makeBackend(): {
  backend: EmulatorBackend
  resolveDeviceId: ReturnType<typeof vi.fn>
  startSession: ReturnType<typeof vi.fn>
  stopHelperForDevice: ReturnType<typeof vi.fn>
  shutdownDevice: ReturnType<typeof vi.fn>
} {
  const resolveDeviceId = vi.fn(async () => {
    throw new Error('shutdown AVD cannot resolve before boot')
  })
  const startSession = vi.fn(async (): Promise<EmulatorSessionInfo> => ({
    deviceUdid: 'emulator-5554',
    streamUrl: 'scrcpy://emulator-5554',
    wsUrl: '',
    streamCodec: 'h264',
    backend: 'android'
  }))
  const stopHelperForDevice = vi.fn(async () => {})
  const shutdownDevice = vi.fn(async () => {})
  const backend: EmulatorBackend = {
    kind: 'android',
    streamCodec: 'h264',
    capabilities: {
      install: false,
      launch: false,
      permissions: false,
      accessibilityTree: false,
      logcat: false
    },
    isSupportedOnHost: () => true,
    checkAvailability: vi.fn(),
    listDevices: vi.fn(async () => []),
    ownsDevice: vi.fn(async () => true),
    resolveDeviceId,
    startSession,
    stopHelperForDevice,
    shutdownDevice,
    isSessionReusable: vi.fn(async () => true),
    tap: vi.fn(async () => {}),
    gesture: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    button: vi.fn(async () => {}),
    rotate: vi.fn(async () => {}),
    exec: vi.fn(async () => undefined)
  }
  return { backend, resolveDeviceId, startSession, stopHelperForDevice, shutdownDevice }
}

describe('EmulatorStartLeaseRegistry', () => {
  it('lets the backend boot a shutdown device before a canonical id exists', async () => {
    const { backend, resolveDeviceId, startSession } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()

    const lease = await registry.acquire(backend, 'Pixel_Tablet', () => false)
    await lease.release()

    expect(resolveDeviceId).not.toHaveBeenCalled()
    expect(startSession).toHaveBeenCalledWith('Pixel_Tablet')
    expect(lease.info.deviceUdid).toBe('emulator-5554')
  })

  it('waits for pending cleanup before starting a new lease', async () => {
    const { backend, startSession, stopHelperForDevice, shutdownDevice } = makeBackend()
    let finishCleanup: (() => void) | undefined
    stopHelperForDevice.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    const registry = new EmulatorStartLeaseRegistry()
    const first = await registry.acquire(backend, 'Pixel_Tablet', () => false)

    const cleanup = first.release({ cleanupIfUnused: true })
    await vi.waitFor(() => expect(stopHelperForDevice).toHaveBeenCalledOnce())
    const second = registry.acquire(backend, 'Pixel_Tablet', () => false)
    await Promise.resolve()
    expect(startSession).toHaveBeenCalledOnce()

    finishCleanup?.()
    await cleanup
    const secondLease = await second

    expect(shutdownDevice).toHaveBeenCalledOnce()
    expect(startSession).toHaveBeenCalledTimes(2)
    await secondLease.release()
  })

  it('claims synchronously before an earlier lease can start cleanup', async () => {
    const { backend, stopHelperForDevice, shutdownDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const first = await registry.acquire(backend, 'Pixel_Tablet', () => false)

    const second = registry.acquire(backend, 'Pixel_Tablet', () => false)
    await first.release({ cleanupIfUnused: true })

    expect(stopHelperForDevice).not.toHaveBeenCalled()
    const secondLease = await second
    await secondLease.release()

    expect(stopHelperForDevice).toHaveBeenCalledOnce()
    expect(shutdownDevice).toHaveBeenCalledOnce()
  })
})
