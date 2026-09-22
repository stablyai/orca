import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readDesktopAwayState } from '../../notifications/desktop-away-state'
import { DeviceRegistry } from '../device-registry'
import { RuntimeMobileNotificationController } from '../runtime-mobile-notification-controller'
import { setRuntimeDesktopSurface } from '../runtime-desktop-surface'
import { DesktopPushService } from './desktop-push-service'
import { PushUnregisterOutbox } from './push-unregister-outbox'
import { createPushHostKeypair } from './push-host-challenge-fixtures'

const paths: string[] = []
const services: DesktopPushService[] = []
const filter = {
  onlyWhenDesktopAway: true
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  services.splice(0).forEach((service) => service.stop())
  paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  setRuntimeDesktopSurface(null)
  vi.restoreAllMocks()
})

async function pipeline() {
  const path = mkdtempSync(join(tmpdir(), 'orca-push-policy-'))
  paths.push(path)
  const registry = new DeviceRegistry(path)
  const device = registry.addDevice('policy-phone', 'mobile')
  const controller = new RuntimeMobileNotificationController()
  const client = {
    registerDevice: vi.fn(async () => ({ ok: true, registrationId: 'policy-registration' })),
    deleteDevice: vi.fn(async () => true),
    send: vi.fn(async () => ({ ok: true, results: [] }))
  }
  const service = DesktopPushService.create({
    runtime: {
      setMobilePushRegistrar: controller.setPushRegistrar.bind(controller),
      onNotificationDispatched: controller.onDispatched.bind(controller)
    } as never,
    runtimeRpc: {
      getE2EEKeypair: () => createPushHostKeypair(),
      getDeviceRegistry: () => registry,
      getPushUnregisterOutbox: () => new PushUnregisterOutbox(path),
      setOnPushUnregisterQueued: () => {}
    } as never,
    gatewayUrl: 'https://push.onorca.dev',
    client: client as never
  })!
  services.push(service)
  service.start()
  const register = () =>
    controller.registerPushDevice({
      deviceId: device.deviceId,
      platform: 'ios',
      token: 'test-token',
      filter
    })
  expect(await register()).toMatchObject({ registered: true })
  const dispatch = () =>
    controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      agentState: 'done',
      notificationId: 'policy-event',
      title: 'Policy test',
      body: 'Policy test'
    })
  return { path, registry, device, controller, client, register, dispatch }
}

it('carries the native idle boundary through replay and push dispatch', async () => {
  let idle = 179
  setRuntimeDesktopSurface({
    isAwayForMobileNotifications: () =>
      readDesktopAwayState({
        getSystemIdleState: () => 'active',
        getSystemIdleTime: () => idle
      }),
    showNotification: () => false,
    findWindowById: () => null,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const h = await pipeline()
  h.dispatch()
  await flush()
  expect(h.client.send).not.toHaveBeenCalled()
  idle = 180
  h.dispatch()
  await flush()
  expect(h.client.send).toHaveBeenCalledTimes(1)
  idle = 0
  h.dispatch()
  await flush()
  expect(h.client.send).toHaveBeenCalledTimes(1)
  const replay = h.controller.getMissedSince(0)
  expect(replay).toHaveLength(3)
  expect(replay.map((event) => (event.type === 'notification' ? event.desktopAway : null))).toEqual(
    [false, true, false]
  )
})

it('keeps headless presence unknown and legacy socket events readable', async () => {
  setRuntimeDesktopSurface(null)
  const h = await pipeline()
  const events: unknown[] = []
  h.controller.onDispatched((event) => events.push(JSON.parse(JSON.stringify(event))))
  h.dispatch()
  await flush()
  expect(events[0]).not.toHaveProperty('desktopAway')
  expect(h.client.send).toHaveBeenCalledTimes(1)
})

it('expires persisted registration at seven days despite host activity and renews explicitly', async () => {
  const now = 1_800_000_000_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const h = await pipeline()
  const deadline = now + 7 * 86400_000
  const persisted = new DeviceRegistry(h.path).getDevice(h.device.deviceId)?.pushRegistration
  expect(persisted?.expiresAt).toBe(deadline)
  clock.mockReturnValue(deadline - 1)
  h.dispatch()
  await flush()
  expect(h.client.send).toHaveBeenCalledTimes(1)
  expect(h.registry.getDevice(h.device.deviceId)?.pushRegistration?.expiresAt).toBe(deadline)
  clock.mockReturnValue(deadline)
  h.dispatch()
  h.controller.dismiss('policy-event')
  await flush()
  expect(h.client.send).toHaveBeenCalledTimes(1)
  await h.register()
  expect(h.registry.getDevice(h.device.deviceId)?.pushRegistration?.expiresAt).toBe(
    deadline + 7 * 86400_000
  )
  h.dispatch()
  await flush()
  expect(h.client.send).toHaveBeenCalledTimes(2)
})
