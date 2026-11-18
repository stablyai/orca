import { describe, expect, it, vi } from 'vitest'
import { AndroidStreamController } from './android-stream-controller'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'

describe('Android stream identity', () => {
  it('reuses the current identity and replaces it after a stream restart', async () => {
    const serial = 'emulator-5554'
    const startStreamSession = vi.fn(async () => {
      scrcpyVideoRegistry.register(serial, () => {})
      return {
        info: {
          deviceUdid: serial,
          streamUrl: `scrcpy://${serial}`,
          wsUrl: '',
          backend: 'android' as const
        },
        handle: { close: () => scrcpyVideoRegistry.stop(serial) }
      }
    })
    const controller = new AndroidStreamController({
      runner: vi.fn(),
      sdk: () => ({ sdkRoot: '/sdk', adb: '/sdk/adb', emulator: '/sdk/emulator' }),
      ensureJar: async () => '/sdk/server.jar',
      startStreamSession,
      maxSize: 1000
    })
    try {
      const first = await controller.start(serial)
      const reused = await controller.start(serial)
      expect(first.instanceId).toBeTruthy()
      expect(reused.instanceId).toBe(first.instanceId)
      expect(controller.isCurrent(first)).toBe(true)
      controller.stop(serial)
      const replacement = await controller.start(serial)
      expect(replacement.instanceId).not.toBe(first.instanceId)
      expect(controller.isCurrent(first)).toBe(false)
      expect(controller.isCurrent({ ...replacement, instanceId: undefined })).toBe(false)
      expect(controller.isCurrent(replacement)).toBe(true)
      const shutdown = vi.fn(async () => {})
      await expect(
        controller.stopForCleanup(
          serial,
          { instanceId: first.instanceId, requireInstanceId: true },
          shutdown
        )
      ).rejects.toThrow('stream changed')
      await expect(
        controller.stopForCleanup(
          serial,
          { instanceId: first.instanceId, requireInstanceId: true, shutdownDevice: true },
          shutdown
        )
      ).rejects.toThrow('stream changed')
      await expect(
        controller.stopForCleanup(
          serial,
          { requireInstanceId: true, shutdownDevice: true },
          shutdown
        )
      ).rejects.toThrow('stream changed')
      expect(controller.isCurrent(replacement)).toBe(true)
      expect(shutdown).not.toHaveBeenCalled()
      const failedShutdown = vi.fn(async () => {
        throw new Error('adb failed')
      })
      await expect(
        controller.stopForCleanup(
          serial,
          { instanceId: replacement.instanceId, requireInstanceId: true, shutdownDevice: true },
          failedShutdown
        )
      ).rejects.toThrow('adb failed')
      expect(controller.isCurrent(replacement)).toBe(false)
      expect(controller.ownedSessionInfo(serial)?.instanceId).toBe(replacement.instanceId)
      await controller.stopForCleanup(
        serial,
        { instanceId: replacement.instanceId, requireInstanceId: true, shutdownDevice: true },
        shutdown
      )
      expect(shutdown).toHaveBeenCalledOnce()
      expect(controller.isCurrent(replacement)).toBe(false)
    } finally {
      controller.stop(serial)
    }
  })
})
