import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { DesktopPushService } from './desktop-push-service'
import { createPushHostKeypair } from './push-host-challenge-fixtures'
import { PushUnregisterOutbox } from './push-unregister-outbox'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, readFileSync: vi.fn(original.readFileSync) }
})

it('refuses registration until unreadable cleanup is recovered and settled on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-push-unreadable-'))
  let service: DesktopPushService | null = null
  try {
    let registry = new DeviceRegistry(dir)
    const { deviceId } = registry.addDevice('phone', 'mobile')
    const queued = new PushUnregisterOutbox(dir).enqueue({ deviceId, registrationId: 'stable-id' })
    const path = join(dir, 'mobile-push-unregister-outbox.json')
    const bytes = readFileSync(path, 'utf-8')
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('temporarily unavailable'), { code: 'EIO' })
    })
    const unreadable = new PushUnregisterOutbox(dir)
    let gatewayLive = true
    const calls: string[] = []
    const client = {
      registerDevice: vi.fn(async () => {
        calls.push('register')
        gatewayLive = true
        return { ok: true, registrationId: 'stable-id' } as const
      }),
      deleteDevice: vi.fn(async () => {
        calls.push('delete')
        gatewayLive = false
        return true
      })
    }
    const createService = (outbox: PushUnregisterOutbox): DesktopPushService =>
      DesktopPushService.create({
        runtime: {
          setMobilePushRegistrar: vi.fn(),
          onNotificationDispatched: () => () => {}
        } as never,
        runtimeRpc: {
          getE2EEKeypair: createPushHostKeypair,
          getDeviceRegistry: () => registry,
          getPushUnregisterOutbox: () => outbox,
          setOnPushUnregisterQueued: vi.fn()
        } as never,
        client: client as never,
        gatewayUrl: 'https://push.invalid',
        scheduleRetry: vi.fn()
      })!
    const input = { deviceId, platform: 'android' as const, token: 'synthetic', filter: {} }
    service = createService(unreadable)
    service.start()
    expect(await service.register(input)).toEqual({
      registered: false,
      reason: 'registration_storage_failed'
    })
    expect(client.registerDevice).not.toHaveBeenCalled()
    expect(client.deleteDevice).not.toHaveBeenCalled()
    expect(registry.getDevice(deviceId)?.pushRegistration).toBeUndefined()
    expect(readFileSync(path, 'utf-8')).toBe(bytes)
    service.stop()

    registry = new DeviceRegistry(dir)
    const recovered = new PushUnregisterOutbox(dir)
    expect(recovered.pending()).toEqual([queued])
    service = createService(recovered)
    service.start()
    expect(await service.register(input)).toEqual({ registered: true, registrationId: 'stable-id' })
    await service.flushUnregisterOutbox()
    expect(calls).toEqual(['delete', 'register'])
    expect(gatewayLive).toBe(true)
    expect(new DeviceRegistry(dir).getDevice(deviceId)?.pushRegistration?.registrationId).toBe(
      'stable-id'
    )
    expect(new PushUnregisterOutbox(dir).pending()).toEqual([])
  } finally {
    service?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
