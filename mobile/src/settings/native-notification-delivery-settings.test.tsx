import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeNotificationDeliverySettings } from './native-notification-delivery-settings'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  support: { resolved: true, supported: false }
}))
vi.mock('react-native', () => ({
  Text: 'Text',
  AppState: { addEventListener: () => ({ remove() {} }) }
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback])
}))
vi.mock('../notifications/NotificationDeliverySection', () => ({
  NotificationDeliverySection: 'Delivery'
}))
vi.mock('../notifications/notification-delivery-preferences', () => ({
  DEFAULT_NOTIFICATION_DELIVERY: {
    onlyWhenDesktopAway: true,
    sound: true,
    suppressWhileViewing: true
  },
  loadNotificationDeliveryPreferences: mocks.load
}))
vi.mock('../notifications/push-registration', () => ({
  setNotificationDeliveryPreferences: mocks.save
}))
vi.mock('../notifications/use-remote-push-capable-hosts', () => ({
  useRemotePushCapableHosts: () => mocks.support
}))
let renderer: ReactTestRenderer
const preferences = { onlyWhenDesktopAway: false, sound: false, suppressWhileViewing: true }
beforeEach(() => {
  mocks.load.mockReset().mockResolvedValue(preferences)
  mocks.save.mockReset().mockResolvedValue(undefined)
  mocks.support = { resolved: true, supported: false }
})
afterEach(() => {
  act(() => renderer?.unmount())
})
const section = () => renderer.root.findByType('Delivery').props
it('keeps stored controls visible but disabled without consent and explains an old host', async () => {
  await act(async () => {
    renderer = create(createElement(NativeNotificationDeliverySettings, { enabled: false }))
  })
  expect(section().value).toEqual(preferences)
  expect(section().disabled).toBe(true)
  expect(JSON.stringify(renderer.toJSON())).toContain('Pair an updated desktop')
  await act(async () => {
    renderer.update(createElement(NativeNotificationDeliverySettings, { enabled: true }))
  })
  expect(section().disabled).toBe(false)
})
it('disables edits until preferences load, then waits for save and retains the prior value on failure', async () => {
  let load!: (value: typeof preferences) => void
  mocks.load.mockReturnValue(
    new Promise((resolve) => {
      load = resolve
    })
  )
  await act(async () => {
    renderer = create(createElement(NativeNotificationDeliverySettings, { enabled: true }))
  })
  expect(section().disabled).toBe(true)
  await act(async () => {
    load(preferences)
  })
  let reject!: (error: Error) => void
  mocks.save.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail
    })
  )
  await act(async () => {
    section().onChange({ ...preferences, sound: true })
  })
  expect(section().disabled).toBe(true)
  await act(async () => {
    reject(new Error('storage unavailable'))
  })
  expect(section().value).toEqual(preferences)
  expect(section().disabled).toBe(false)
  expect(JSON.stringify(renderer.toJSON())).toContain('Could not save delivery settings')
})
it('does not claim an upgrade is needed while probing or when a host supports push', async () => {
  mocks.support = { resolved: false, supported: false }
  await act(async () => {
    renderer = create(createElement(NativeNotificationDeliverySettings, { enabled: true }))
  })
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Pair an updated desktop')
  mocks.support = { resolved: true, supported: true }
  await act(async () => {
    renderer.update(createElement(NativeNotificationDeliverySettings, { enabled: true }))
  })
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Pair an updated desktop')
})
