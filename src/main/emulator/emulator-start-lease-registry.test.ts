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
  const shutdownDevice = vi.fn(async () => {})
  const stopHelperForDevice = vi.fn(
    async (_device: string, options?: { shutdownDevice?: boolean }) => {
      if (options?.shutdownDevice) {
        await shutdownDevice()
      }
    }
  )
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
  it('waits for pending cleanup before starting a new lease', async () => {
    const { backend, startSession, stopHelperForDevice, shutdownDevice } = makeBackend()
    let finishCleanup: (() => void) | undefined
    stopHelperForDevice.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = () => {
            void backend.shutdownDevice('emulator-5554').then(resolve)
          }
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

  it('waits for an in-flight claim before stopping the target', async () => {
    const { backend, stopHelperForDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const lease = await registry.acquire(backend, 'Pixel_Tablet', () => false)
    const cleanup = registry.cleanupWhenIdle(backend, lease.info, () => false, {
      shutdownDevice: true
    })
    await Promise.resolve()
    expect(stopHelperForDevice).not.toHaveBeenCalled()
    await lease.release()
    await cleanup
    expect(stopHelperForDevice).toHaveBeenCalledWith(
      'emulator-5554',
      expect.objectContaining({ shutdownDevice: true })
    )
  })

  it('honors kill and shutdown queued for the same stream generation', async () => {
    const { backend, stopHelperForDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const lease = await registry.acquire(backend, 'device', () => false)
    const info = { ...lease.info, instanceId: 'stream-1' }
    const kill = registry.cleanupWhenIdle(backend, info, () => false, { force: true })
    const shutdown = registry.cleanupWhenIdle(backend, info, () => false, {
      force: true,
      shutdownDevice: true
    })
    await lease.release()
    await Promise.all([kill, shutdown])
    expect(stopHelperForDevice).toHaveBeenCalledWith(
      'emulator-5554',
      expect.objectContaining({ instanceId: 'stream-1', shutdownDevice: true })
    )
  })

  it('rejects only a stale request when a valid request for the same generation is queued', async () => {
    const { backend, stopHelperForDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const lease = await registry.acquire(backend, 'device', () => false)
    const info = { ...lease.info, instanceId: 'stream-1' }
    const stale = registry.cleanupWhenIdle(backend, info, () => false, {
      force: true,
      validate: () => {
        throw new Error('stale')
      }
    })
    const staleResult = stale.then(
      () => 'ok',
      (error: Error) => error.message
    )
    const valid = registry.cleanupWhenIdle(backend, info, () => false, {
      force: true,
      shutdownDevice: true
    })
    await lease.release()
    await valid
    expect(await staleResult).toBe('stale')
    expect(stopHelperForDevice).toHaveBeenCalledWith(
      'emulator-5554',
      expect.objectContaining({ shutdownDevice: true })
    )
  })

  it('closes start admission and waits for an in-flight start to settle', async () => {
    const { backend, startSession } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    let finish!: (info: EmulatorSessionInfo) => void
    startSession.mockImplementationOnce(
      () =>
        new Promise<EmulatorSessionInfo>((resolve) => {
          finish = resolve
        })
    )
    const starting = registry.acquire(backend, 'device', () => false)
    const startingResult = starting.then(
      () => 'started',
      (error: Error) => error.message
    )
    await vi.waitFor(() => expect(finish).toBeDefined())
    const closing = registry.closeAndDrain()
    await expect(registry.acquire(backend, 'other', () => false)).rejects.toThrow('shutdown')
    finish({
      deviceUdid: 'emulator-5554',
      streamUrl: 'scrcpy://emulator-5554',
      wsUrl: '',
      instanceId: 'stream-1'
    })
    expect(await startingResult).toContain('shutdown')
    await closing
  })

  it('preserves a forced stop when a conditional detach is queued later', async () => {
    const { backend, stopHelperForDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const lease = await registry.acquire(backend, 'device', () => true)
    const forced = registry.cleanupWhenIdle(backend, lease.info, () => false, { force: true })
    const conditional = registry.cleanupWhenIdle(backend, lease.info, () => true, {
      shutdownDevice: true
    })
    await lease.release()
    await Promise.all([forced, conditional])
    expect(stopHelperForDevice).toHaveBeenCalledWith(
      'emulator-5554',
      expect.objectContaining({ shutdownDevice: false })
    )
  })

  it('rejects a forced stop whose captured generation changed while a claim was in flight', async () => {
    const { backend, stopHelperForDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const lease = await registry.acquire(backend, 'device', () => false)
    let current = true
    const forced = registry.cleanupWhenIdle(backend, lease.info, () => false, {
      force: true,
      validate: () => {
        if (!current) {
          throw new Error('changed')
        }
      }
    })
    const result = forced.then(
      () => 'stopped',
      (error: Error) => error.message
    )
    current = false
    await lease.release()
    expect(await result).toBe('changed')
    expect(stopHelperForDevice).not.toHaveBeenCalled()
  })

  it('does not send a deferred cleanup failure to an unrelated lease', async () => {
    const { backend, stopHelperForDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const unrelated = await registry.acquire(backend, 'device-b', () => false)
    stopHelperForDevice.mockRejectedValueOnce(new Error('cleanup A failed'))
    const cleanupA = registry.cleanupWhenIdle(
      backend,
      { ...unrelated.info, deviceUdid: 'device-a' },
      () => false
    )
    const resultA = cleanupA.then(
      () => 'ok',
      (error: Error) => error.message
    )
    await expect(unrelated.release()).resolves.toBeUndefined()
    expect(await resultA).toBe('cleanup A failed')
  })

  it('reports a deferred stop failure to the workspace waiting for cleanup', async () => {
    const { backend, stopHelperForDevice } = makeBackend()
    const registry = new EmulatorStartLeaseRegistry()
    const lease = await registry.acquire(backend, 'Pixel_Tablet', () => false)
    stopHelperForDevice.mockRejectedValueOnce(new Error('ownership lost'))
    const cleanup = registry.cleanupWhenIdle(backend, lease.info, () => false, {
      shutdownDevice: true
    })
    const [, failedCleanup] = await Promise.allSettled([lease.release(), cleanup])
    expect(failedCleanup).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'ownership lost' })
    })
  })

  it('reports a helper stop failure and does not shut down its device', async () => {
    const { backend, stopHelperForDevice, shutdownDevice } = makeBackend()
    stopHelperForDevice.mockRejectedValueOnce(new Error('ownership lost'))
    const registry = new EmulatorStartLeaseRegistry()
    const lease = await registry.acquire(backend, 'Pixel_Tablet', () => false)

    await expect(lease.release({ cleanupIfUnused: true })).rejects.toThrow('ownership lost')
    expect(shutdownDevice).not.toHaveBeenCalled()
  })
})
