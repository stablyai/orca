import { afterEach, expect, it, vi } from 'vitest'
import { createHarness, flush, notification, registration } from './push-dispatcher.test-fixture'
import { parseMobilePushRegistration } from '../../../shared/mobile-push-contract'

afterEach(() => vi.useRealTimers())

it('does not send or consume cooldown while the desktop is active', async () => {
  const reg = registration()
  reg.filter = { ...reg.filter, onlyWhenDesktopAway: true }
  const { dispatcher, sends } = createHarness({
    devices: [{ deviceId: 'phone', pushRegistration: reg }]
  })
  dispatcher.enqueue(notification({ desktopAway: false, emittedAt: 10_000 }))
  dispatcher.enqueue(notification({ desktopAway: true, emittedAt: 10_001 }))
  await flush()
  expect(sends).toHaveLength(1)
})

it('expires per phone at the boundary, preserves leases across persistence, and permits renewal', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(50_000)
  const expired = parseMobilePushRegistration(registration({ expiresAt: 50_000 }))!
  const devices = [{ deviceId: 'phone', pushRegistration: expired }]
  const { dispatcher, sends } = createHarness({ devices })
  dispatcher.enqueue(notification())
  await flush()
  expect(sends).toHaveLength(0)
  devices[0].pushRegistration = registration({ expiresAt: 50_001 })
  dispatcher.enqueue(notification())
  await flush()
  expect(sends).toHaveLength(1)
})

it('rechecks expiry before a retry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(10)
  const { dispatcher, sends, runRetry } = createHarness({
    devices: [{ deviceId: 'phone', pushRegistration: registration({ expiresAt: 20 }) }],
    sendImpl: async () => ({ ok: false, reason: 'unreachable' }) as never
  })
  dispatcher.enqueue(notification())
  await flush()
  vi.setSystemTime(20)
  runRetry()
  await flush()
  expect(sends).toHaveLength(1)
  expect(parseMobilePushRegistration({ ...registration(), expiresAt: undefined })).toBeUndefined()
})
