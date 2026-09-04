import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MobileNotificationEvent } from '../runtime-mobile-notification-controller'
import { DeviceRegistry } from '../device-registry'
import { DesktopPushService } from './desktop-push-service'
import { PushUnregisterOutbox } from './push-unregister-outbox'
import { createPushHostKeypair } from './push-host-challenge-fixtures'

const REGISTER_INPUT = {
  platform: 'android' as const,
  token: 'fcm-token',
  filter: { sources: ['agent-task-complete'] as const, agentStates: ['finished'] as const }
}

function createService(options: { registerFails?: boolean; deleteFails?: boolean } = {}): {
  service: DesktopPushService
  registry: DeviceRegistry
  outbox: PushUnregisterOutbox
  deviceId: string
  deletes: string[]
  send: ReturnType<typeof vi.fn>
  dispatch: (event: MobileNotificationEvent) => void
} {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-push-service-'))
  const registry = new DeviceRegistry(userDataPath)
  const outbox = new PushUnregisterOutbox(userDataPath)
  const device = registry.addDevice('phone', 'mobile')
  const deletes: string[] = []
  let listener: ((event: MobileNotificationEvent) => void) | null = null

  const runtime = {
    setMobilePushRegistrar: vi.fn(),
    onNotificationDispatched: vi.fn((next: (event: MobileNotificationEvent) => void) => {
      listener = next
      return () => {
        listener = null
      }
    })
  }
  const runtimeRpc = {
    getE2EEKeypair: () => createPushHostKeypair(),
    getDeviceRegistry: () => registry,
    getPushUnregisterOutbox: () => outbox,
    setOnPushUnregisterQueued: vi.fn()
  }
  // A stub gateway keeps the suite on the service's own persistence decisions.
  const client = {
    registerDevice: vi.fn(async () =>
      options.registerFails
        ? ({ ok: false, reason: 'unreachable' } as const)
        : ({ ok: true, registrationId: 'reg-1' } as const)
    ),
    deleteDevice: vi.fn(async (registrationId: string) => {
      deletes.push(registrationId)
      return options.deleteFails
        ? { deleted: false, retryable: true }
        : { deleted: true, retryable: false }
    }),
    send: vi.fn(async () => ({ ok: true, results: [] }) as const)
  }
  const service = DesktopPushService.create({
    runtime: runtime as never,
    runtimeRpc: runtimeRpc as never,
    gatewayUrl: 'https://push.onorca.dev',
    client: client as never
  })!

  service.start()
  return {
    service,
    registry,
    outbox,
    deviceId: device.deviceId,
    deletes,
    send: client.send,
    dispatch: (event) => listener?.(event)
  }
}

describe('DesktopPushService', () => {
  it('persists the registration the gateway hands back', async () => {
    const harness = createService()

    expect(
      await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })
    ).toEqual({ registered: true, registrationId: 'reg-1' })
    expect(harness.registry.getDevice(harness.deviceId)?.pushRegistration).toMatchObject({
      registrationId: 'reg-1',
      platform: 'android',
      filter: REGISTER_INPUT.filter
    })
  })

  it('persists nothing when the gateway is unreachable', async () => {
    const harness = createService({ registerFails: true })

    expect(
      await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })
    ).toEqual({ registered: false, reason: 'gateway_unreachable' })
    expect(harness.registry.getDevice(harness.deviceId)?.pushRegistration).toBeUndefined()
  })

  it('refuses to register a device that is not a paired phone', async () => {
    const harness = createService()

    expect(await harness.service.register({ deviceId: 'not-a-device', ...REGISTER_INPUT })).toEqual(
      {
        registered: false,
        reason: 'not_mobile'
      }
    )
  })

  it('clears the local registration and deletes at the gateway on unregister', async () => {
    const harness = createService()
    await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })

    expect(await harness.service.unregister(harness.deviceId)).toEqual({ unregistered: true })
    expect(harness.registry.getDevice(harness.deviceId)?.pushRegistration).toBeUndefined()
    expect(harness.deletes).toEqual(['reg-1'])
    expect(harness.outbox.pending()).toEqual([])
  })

  it('keeps the delete queued when the gateway cannot be reached', async () => {
    const harness = createService({ deleteFails: true })
    await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })

    await harness.service.unregister(harness.deviceId)

    expect(harness.registry.getDevice(harness.deviceId)?.pushRegistration).toBeUndefined()
    expect(harness.outbox.pending()).toEqual([
      expect.objectContaining({ registrationId: 'reg-1', deviceId: harness.deviceId })
    ])
  })

  it('reports nothing to unregister for a device that never enabled push', async () => {
    const harness = createService()
    expect(await harness.service.unregister(harness.deviceId)).toEqual({ unregistered: false })
  })

  it('drains a delete queued before this launch', async () => {
    const harness = createService()
    harness.outbox.enqueue({ registrationId: 'reg-stale', deviceId: 'device-gone' })

    await harness.service.flushUnregisterOutbox()

    expect(harness.deletes).toEqual(['reg-stale'])
    expect(harness.outbox.pending()).toEqual([])
  })

  it('pushes a dispatched notification through the subscribed dispatcher', async () => {
    const harness = createService()
    await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })

    harness.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'feat/x - Claude finished',
      body: 'Done.',
      notificationSeq: 3,
      notificationEpoch: 'epoch-1',
      agentState: 'done'
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({ registrationIds: ['reg-1'] })
    )
  })
})
