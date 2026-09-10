import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { DesktopPushService } from './desktop-push-service'
import { PushUnregisterOutbox } from './push-unregister-outbox'
import { createPushHostKeypair } from './push-host-challenge-fixtures'
import { PushDispatcher } from './push-dispatcher'

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
const input = {
  platform: 'android' as const,
  token: 'synthetic',
  filter: {}
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

function harness() {
  const path = mkdtempSync(join(tmpdir(), 'push-races-'))
  paths.push(path)
  const registry = new DeviceRegistry(path)
  const deviceId = registry.addDevice('phone', 'mobile').deviceId
  const outbox = new PushUnregisterOutbox(path)
  const retries: { run: () => void; delayMs: number }[] = []
  let live = false
  let reachable = true
  const client = {
    registerDevice: vi.fn(async () => {
      live = true
      return { ok: true, registrationId: 'stable-id' }
    }),
    deleteDevice: vi.fn(async (_registrationId: string) => {
      if (!reachable) {
        return false
      }
      live = false
      return true
    }),
    send: vi.fn()
  }
  const service = DesktopPushService.create({
    gatewayUrl: 'https://push.example.test',
    client: client as never,
    scheduleRetry: (run, delayMs) => retries.push({ run, delayMs }),
    runtime: {
      setMobilePushRegistrar: () => {},
      onNotificationDispatched: () => () => {}
    } as never,
    runtimeRpc: {
      getE2EEKeypair: createPushHostKeypair,
      getDeviceRegistry: () => registry,
      getPushUnregisterOutbox: () => outbox,
      setOnPushUnregisterQueued: () => {}
    } as never
  })!
  service.start()
  return {
    path,
    retries,
    registry,
    deviceId,
    outbox,
    client,
    service,
    live: () => live,
    reachable: (value: boolean) => {
      reachable = value
    }
  }
}

it('deletes obsolete gateway state before reporting successful re-enable', async () => {
  const h = harness()
  await h.service.register({ ...input, deviceId: h.deviceId })
  h.reachable(false)
  await h.service.unregister(h.deviceId)
  await h.service.flushUnregisterOutbox()
  expect(h.outbox.pending()).toHaveLength(1)
  expect(await h.service.register({ ...input, deviceId: h.deviceId })).toMatchObject({
    registered: false
  })
  h.reachable(true)
  expect(await h.service.register({ ...input, deviceId: h.deviceId })).toMatchObject({
    registered: true
  })
  await h.service.flushUnregisterOutbox()
  expect(h.live()).toBe(true)
  expect(h.outbox.pending()).toEqual([])
})

it('waits for an already-running delete before re-registering', async () => {
  const h = harness()
  await h.service.register({ ...input, deviceId: h.deviceId })
  let release!: () => void
  const normalDelete = h.client.deleteDevice.getMockImplementation()!
  h.client.deleteDevice.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return normalDelete('stable-id')
  })
  await h.service.unregister(h.deviceId)
  await tick()
  const registration = h.service.register({ ...input, deviceId: h.deviceId })
  await tick()
  expect(h.client.registerDevice).toHaveBeenCalledTimes(1)
  release()
  await registration
  await h.service.flushUnregisterOutbox()
  expect(h.live()).toBe(true)
})

it('orders unregister after a register already in flight', async () => {
  const h = harness()
  let release!: () => void
  const normalRegister = h.client.registerDevice.getMockImplementation()!
  h.client.registerDevice.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return normalRegister()
  })
  const registered = h.service.register({ ...input, deviceId: h.deviceId })
  await tick()
  const unregistered = h.service.unregister(h.deviceId)
  release()
  await Promise.all([registered, unregistered])
  await h.service.flushUnregisterOutbox()
  expect(h.registry.getDevice(h.deviceId)?.pushRegistration).toBeUndefined()
  expect(h.live()).toBe(false)
})

it('does not clear a replacement with the same ID and timestamp after a stale dead response', async () => {
  const h = harness()
  await h.service.register({ ...input, deviceId: h.deviceId })
  let finish!: (value: unknown) => void
  h.client.send.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const dispatcher = new PushDispatcher({ registry: h.registry, client: h.client as never })
  dispatcher.enqueue({
    type: 'notification',
    source: 'plugin',
    title: 'test',
    body: '',
    notificationEpoch: 'epoch',
    notificationSeq: 1
  })
  const original = h.registry.getDevice(h.deviceId)!.pushRegistration!
  h.registry.setPushRegistration(h.deviceId, { ...original })
  finish({ ok: true, results: [{ registrationId: 'stable-id', status: 'dead' }] })
  await tick()
  expect(h.registry.getDevice(h.deviceId)?.pushRegistration).toEqual(original)
})

it('drains a cleanup queued as an empty flush is completing', async () => {
  const h = harness()
  // Let the startup drain return, but queue cleanup before its promise finalizer runs.
  await Promise.resolve()
  h.outbox.enqueue({ registrationId: 'orphan', deviceId: h.deviceId })
  await h.service.flushUnregisterOutbox()
  expect(h.client.deleteDevice).toHaveBeenCalledWith('orphan')
  expect(h.outbox.pending()).toEqual([])
})

it('preserves the live route when clearing local registration fails, then cleans before re-registering', async () => {
  const h = harness()
  await h.service.register({ ...input, deviceId: h.deviceId })
  await h.service.flushUnregisterOutbox()
  const persist = vi.spyOn(h.registry, 'setPushRegistration').mockImplementation(() => {
    throw new Error('disk full')
  })
  await expect(h.service.unregister(h.deviceId)).rejects.toThrow('disk full')
  await tick()
  expect(h.client.deleteDevice).not.toHaveBeenCalled()
  expect(h.outbox.pending()).toHaveLength(1)
  expect(h.live()).toBe(true)
  persist.mockRestore()
  expect(await h.service.register({ ...input, deviceId: h.deviceId })).toMatchObject({
    registered: true
  })
  await h.service.flushUnregisterOutbox()
  expect(h.client.deleteDevice).toHaveBeenCalledWith('stable-id')
  expect(h.outbox.pending()).toEqual([])
  expect(h.live()).toBe(true)
  h.service.stop()
})

it('retries an old failure before mid-drain work, then waits for the armed backoff', async () => {
  const h = harness()
  await h.service.flushUnregisterOutbox()
  const deletes: string[] = []
  h.client.deleteDevice.mockImplementation(async (registrationId) => {
    deletes.push(registrationId)
    if (deletes.length === 1) {
      h.outbox.enqueue({ registrationId: 'new', deviceId: 'new-phone' })
      void h.service.flushUnregisterOutbox()
    }
    return registrationId === 'new'
  })
  h.outbox.enqueue({ registrationId: 'old', deviceId: h.deviceId })
  await h.service.flushUnregisterOutbox()
  expect(deletes).toEqual(['old', 'old', 'new'])
  expect(h.outbox.pending().map((item) => item.registrationId)).toEqual(['old'])
  expect(h.retries.map((retry) => retry.delayMs)).toEqual([30_000])
  await tick()
  expect(deletes).toHaveLength(3)
  h.retries[0].run()
  await tick()
  expect(deletes).toEqual(['old', 'old', 'new', 'old'])
  expect(h.retries.map((retry) => retry.delayMs)).toEqual([30_000, 60_000])
  h.service.stop()
})

it('skips a snapshot delete consumed by same-device registration cleanup', async () => {
  const h = harness()
  await h.service.flushUnregisterOutbox()
  let release!: () => void
  h.client.deleteDevice.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true)
      })
  )
  h.outbox.enqueue({ registrationId: 'blocker', deviceId: 'other-phone' })
  h.outbox.enqueue({ registrationId: 'stable-id', deviceId: h.deviceId })
  const flush = h.service.flushUnregisterOutbox()
  await tick()
  expect(await h.service.register({ ...input, deviceId: h.deviceId })).toMatchObject({
    registered: true
  })
  expect(h.live()).toBe(true)
  release()
  await flush
  expect(h.client.deleteDevice.mock.calls).toEqual([['blocker'], ['stable-id']])
  expect(h.outbox.pending()).toEqual([])
  expect(h.live()).toBe(true)
  h.service.stop()
})

it('finishes the current snapshot on stop and leaves later work durable for restart', async () => {
  const h = harness()
  await h.service.flushUnregisterOutbox()
  let release!: () => void
  h.client.deleteDevice.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(false)
      })
  )
  h.outbox.enqueue({ registrationId: 'blocked', deviceId: h.deviceId })
  h.outbox.enqueue({ registrationId: 'in-snapshot', deviceId: 'other-phone' })
  const flush = h.service.flushUnregisterOutbox()
  await tick()
  h.outbox.enqueue({ registrationId: 'late', deviceId: 'late-phone' })
  void h.service.flushUnregisterOutbox()
  h.service.stop()
  release()
  await flush
  expect(h.client.deleteDevice.mock.calls).toEqual([['blocked'], ['in-snapshot']])
  expect(h.retries).toEqual([])
  const recovered = new PushUnregisterOutbox(h.path)
  expect(recovered.pending().map((item) => item.registrationId)).toEqual(['blocked', 'late'])
  await h.service.flushUnregisterOutbox()
  expect(h.client.deleteDevice).toHaveBeenCalledTimes(2)
  h.service.start()
  await h.service.flushUnregisterOutbox()
  expect(h.outbox.pending()).toEqual([])
  h.service.stop()
})

it('reports shutdown as retryable and allows registration after restart', async () => {
  const h = harness()
  h.service.stop()
  expect(await h.service.register({ ...input, deviceId: h.deviceId })).toEqual({
    registered: false,
    reason: 'gateway_unreachable'
  })
  expect(h.client.registerDevice).not.toHaveBeenCalled()
  h.service.start()
  expect(await h.service.register({ ...input, deviceId: h.deviceId })).toMatchObject({
    registered: true
  })
  h.service.stop()
})
