import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { OrcaRuntimeService } from '../orca-runtime'
import { DesktopPushService } from './desktop-push-service'
import { createPushHostKeypair } from './push-host-challenge-fixtures'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'

describe('mobile revoke when the registry write fails', () => {
  it('preserves a live route after failed unpair and deletes it after durable removal', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-revoke-write-failure-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('phone', 'mobile')
    registry.setPushRegistration(device.deviceId, {
      registrationId: 'reg-live',
      filter: {},
      expiresAt: Date.now() + 60_000
    })
    server['deviceRegistry'] = registry
    server['e2eeKeypair'] = createPushHostKeypair()

    const deleted: string[] = []
    const client = {
      registerDevice: vi.fn(),
      deleteDevice: vi.fn(async (registrationId: string) => {
        deleted.push(registrationId)
        return true
      }),
      send: vi.fn(async () => ({ ok: true, results: [] }) as const)
    }
    const service = DesktopPushService.create({
      runtime,
      runtimeRpc: server,
      gatewayUrl: 'https://push.onorca.dev',
      client: client as never
    })!
    service.start()
    const save = registry['save'].bind(registry)
    registry['save'] = vi.fn(() => {
      throw new Error('disk full')
    })

    await expect(server.revokeMobileDevice(device.deviceId)).rejects.toThrow('disk full')
    await service.flushUnregisterOutbox()

    expect(registry.getDevice(device.deviceId)?.pushRegistration?.registrationId).toBe('reg-live')
    expect(deleted).toEqual([])
    expect(server.getPushUnregisterOutbox().pending()).toHaveLength(1)
    service.stop()
    service.start()
    await service.flushUnregisterOutbox()
    expect(deleted).toEqual([])
    registry['save'] = save
    expect(await server.revokeMobileDevice(device.deviceId)).toBe(true)
    await service.flushUnregisterOutbox()
    expect(deleted).toEqual(['reg-live'])
    expect(server.getPushUnregisterOutbox().pending()).toEqual([])
    service.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })
})
