import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import { DeviceRegistry } from '../rpc/server/pairing/device-registry'
import { DesktopPushService } from './desktop-push-service'
import { PushRegisterThrottle } from './push-register-throttle'
import { PushUnregisterOutbox } from './push-unregister-outbox'
import { createPushHostKeypair } from './push-host-challenge-fixtures'

const REGISTER_INPUT = {
  platform: 'android' as const,
  token: 'fcm-token',
  filter: {}
}

function createService(
  options: {
    registerFails?: boolean
    deleteFails?: boolean
    /** Runs before each delete resolves, so a suite can queue work mid-flush. */
    onDelete?: (registrationId: string) => void
    now?: () => number
  } = {}
): {
  service: DesktopPushService
  registry: DeviceRegistry
  outbox: PushUnregisterOutbox
  deviceId: string
  deletes: string[]
  send: ReturnType<typeof vi.fn>
  registerDevice: ReturnType<typeof vi.fn>
  dispatch: (event: MobileNotificationEvent) => void
  retries: { run: () => void; delayMs: number }[]
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
  const client = {
    registerDevice: vi.fn(async () =>
      options.registerFails
        ? ({ ok: false, reason: 'unreachable' } as const)
        : ({ ok: true, registrationId: 'reg-1' } as const)
    ),
    deleteDevice: vi.fn(async (registrationId: string) => {
      deletes.push(registrationId)
      options.onDelete?.(registrationId)
      return !options.deleteFails
    }),
    send: vi.fn(async () => ({ ok: true, results: [] }) as const)
  }
  const retries: { run: () => void; delayMs: number }[] = []
  const service = DesktopPushService.create({
    runtime: runtime as never,
    runtimeRpc: runtimeRpc as never,
    gatewayUrl: 'https://push.onorca.dev',
    client: client as never,
    scheduleRetry: (run, delayMs) => {
      retries.push({ run, delayMs })
    },
    ...(options.now ? { registerThrottle: new PushRegisterThrottle({ now: options.now }) } : {})
  })!

  service.start()
  return {
    service,
    registry,
    outbox,
    deviceId: device.deviceId,
    deletes,
    send: client.send,
    registerDevice: client.registerDevice,
    dispatch: (event) => listener?.(event),
    retries
  }
}

describe('DesktopPushService', () => {
  it('keeps the delete queued when the gateway cannot be reached', async () => {
    const harness = createService({ deleteFails: true })
    await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })

    await harness.service.unregister(harness.deviceId)

    expect(harness.registry.getDevice(harness.deviceId)?.pushRegistration).toBeUndefined()
    expect(harness.outbox.pending()).toEqual([
      expect.objectContaining({ registrationId: 'reg-1', deviceId: harness.deviceId })
    ])
  })

  it('unregisters at the gateway when the device stopped being a phone mid-register', async () => {
    const harness = createService()
    vi.spyOn(harness.registry, 'setPushRegistration').mockReturnValue(false)

    expect(
      await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })
    ).toEqual({ registered: false, reason: 'not_mobile' })
    // register starts a detached flush; join that same drain.
    await harness.service.flushUnregisterOutbox()
    expect(harness.deletes).toEqual(['reg-1'])
    expect(harness.outbox.pending()).toEqual([])
  })

  it('unregisters at the gateway when the registration cannot be written', async () => {
    const harness = createService({ deleteFails: true })
    vi.spyOn(harness.registry, 'setPushRegistration').mockImplementation(() => {
      throw new Error('disk full')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      await harness.service.register({ deviceId: harness.deviceId, ...REGISTER_INPUT })
    ).toEqual({ registered: false, reason: 'registration_storage_failed' })
    expect(harness.outbox.pending()).toEqual([
      expect.objectContaining({ registrationId: 'reg-1', deviceId: harness.deviceId })
    ])
    warn.mockRestore()
  })

  it('drains a delete queued while a flush is already running', async () => {
    let queued = false
    const harness = createService({
      onDelete: () => {
        if (queued) {
          return
        }
        queued = true
        harness.outbox.enqueue({ registrationId: 'reg-late', deviceId: 'device-late' })
        // Mirrors unregister(): the trigger arrives while the flush is mid-await.
        void harness.service.flushUnregisterOutbox()
      }
    })
    harness.outbox.enqueue({ registrationId: 'reg-first', deviceId: 'device-first' })

    await harness.service.flushUnregisterOutbox()

    expect(harness.deletes).toEqual(['reg-first', 'reg-late'])
    expect(harness.outbox.pending()).toEqual([])
  })

  it('retries a failed drain on a capped backoff instead of waiting for a relaunch', async () => {
    const harness = createService({ deleteFails: true })
    harness.outbox.enqueue({ registrationId: 'reg-stuck', deviceId: 'device-1' })

    await harness.service.flushUnregisterOutbox()
    expect(harness.retries.map((entry) => entry.delayMs)).toEqual([30_000])

    harness.retries[0]?.run()
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.deletes).toEqual(['reg-stuck', 'reg-stuck'])
    expect(harness.retries.map((entry) => entry.delayMs)).toEqual([30_000, 60_000])
    expect(harness.outbox.pending()).toHaveLength(1)
  })

  it('stops re-arming the retry once the service is stopped', async () => {
    const harness = createService({ deleteFails: true })
    harness.outbox.enqueue({ registrationId: 'reg-stuck', deviceId: 'device-1' })
    await harness.service.flushUnregisterOutbox()

    harness.service.stop()
    harness.retries[0]?.run()
    await new Promise((resolve) => setImmediate(resolve))

    expect(harness.retries).toHaveLength(1)
  })

  it('throttles a device that registers in a loop and lets it back in a minute later', async () => {
    let clock = 1_700_000_000_000
    const harness = createService({ now: () => clock })
    const input = { deviceId: harness.deviceId, ...REGISTER_INPUT }

    for (let index = 0; index < 10; index++) {
      expect(await harness.service.register(input)).toEqual({
        registered: true,
        registrationId: 'reg-1'
      })
    }
    expect(await harness.service.register(input)).toEqual({
      registered: false,
      reason: 'throttled'
    })
    expect(harness.registry.getDevice(harness.deviceId)?.pushRegistration?.registrationId).toBe(
      'reg-1'
    )

    clock += 60_000
    expect(await harness.service.register(input)).toEqual({
      registered: true,
      registrationId: 'reg-1'
    })
  })
})

it('renews a seven-day mobile lease only on explicit registration', async () => {
  const now = 1_800_000_000_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const h = createService()
  try {
    await h.service.register({
      deviceId: h.deviceId,
      ...REGISTER_INPUT
    })
    expect(h.registry.getDevice(h.deviceId)?.pushRegistration?.expiresAt).toBe(now + 7 * 86400_000)
    clock.mockReturnValue(now + 86400_000)
    h.dispatch({ type: 'notification', source: 'terminal-bell', title: 'QA', body: 'QA' })
    expect(h.registry.getDevice(h.deviceId)?.pushRegistration?.expiresAt).toBe(now + 7 * 86400_000)
    await h.service.register({
      deviceId: h.deviceId,
      ...REGISTER_INPUT
    })
    expect(h.registry.getDevice(h.deviceId)?.pushRegistration?.expiresAt).toBe(now + 8 * 86400_000)
  } finally {
    h.service.stop()
    clock.mockRestore()
  }
})

it('does not claim success for missing registrations or failed gateway sends', async () => {
  const { service, deviceId, send } = createService()
  await expect(service.test(deviceId)).resolves.toEqual({
    accepted: false,
    reason: 'not_registered'
  })
  expect(send).not.toHaveBeenCalled()
  await service.register({ ...REGISTER_INPUT, deviceId })
  send.mockResolvedValue({ ok: false, reason: 'unreachable' })
  await expect(service.test(deviceId)).resolves.toEqual({ accepted: false, reason: 'unavailable' })
  send.mockResolvedValue({
    ok: true,
    results: [{ registrationId: 'reg-1', status: 'rate_limited' }]
  })
  await expect(service.test(deviceId)).resolves.toEqual({ accepted: false, reason: 'rate_limited' })
})

describe('host mobile push privacy', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('keeps existing content delivery when the host has no privacy override', async () => {
    vi.stubEnv('ORCA_MOBILE_PUSH_MODE', undefined)
    const h = createService()
    try {
      await h.service.register({ ...REGISTER_INPUT, deviceId: h.deviceId })
      h.dispatch({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Private project',
        body: 'Agent context',
        notificationId: 'project-alert',
        notificationSeq: 1,
        notificationEpoch: 'epoch'
      })
      expect(h.send).toHaveBeenCalledWith({
        registrationIds: ['reg-1'],
        notification: expect.objectContaining({
          title: 'Private project',
          body: 'Agent context',
          notificationId: 'project-alert'
        })
      })
    } finally {
      h.service.stop()
    }
  })

  it.each(['disabled', 'invalid-mode'])(
    'blocks registration and delivery in %s mode while retaining cleanup',
    async (mode) => {
      vi.stubEnv('ORCA_MOBILE_PUSH_MODE', mode)
      const h = createService()
      try {
        await expect(
          h.service.register({ ...REGISTER_INPUT, deviceId: h.deviceId })
        ).resolves.toEqual({ registered: false, reason: 'gateway_rejected' })
        expect(h.registerDevice).not.toHaveBeenCalled()
        h.registry.setPushRegistration(h.deviceId, {
          registrationId: 'existing-reg',
          filter: {},
          expiresAt: Date.now() + 60_000
        })
        h.dispatch({
          type: 'notification',
          source: 'terminal-bell',
          title: 'Private',
          body: 'Context',
          notificationSeq: 1,
          notificationEpoch: 'epoch'
        })
        await expect(h.service.test(h.deviceId)).resolves.toEqual({
          accepted: false,
          reason: 'unavailable'
        })
        expect(h.send).not.toHaveBeenCalled()
        await h.service.unregister(h.deviceId)
        await h.service.flushUnregisterOutbox()
        expect(h.deletes).toEqual(['existing-reg'])
      } finally {
        h.service.stop()
      }
    }
  )
})
