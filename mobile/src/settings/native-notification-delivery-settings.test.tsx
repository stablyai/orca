import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeNotificationDeliverySettings } from './native-notification-delivery-settings'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  support: { resolved: true, supported: false },
  appState: null as null | ((state: string) => void)
}))
vi.mock('react-native', () => ({
  Text: 'Text',
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      mocks.appState = callback
      return { remove() {} }
    }
  }
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

it.each(['resolve', 'reject'])('ignores a pre-save refresh that later %ss', async (outcome) => {
  await act(async () => {
    renderer = create(createElement(NativeNotificationDeliverySettings, { enabled: true }))
  })
  let resolve!: (value: typeof preferences) => void
  let reject!: (error: Error) => void
  mocks.load.mockReturnValue(
    new Promise((ok, fail) => {
      resolve = ok
      reject = fail
    })
  )
  await act(async () => mocks.appState!('active'))
  const saved = { ...preferences, sound: true }
  await act(async () => section().onChange(saved))
  await act(async () => {
    if (outcome === 'resolve') {
      resolve(preferences)
    } else {
      reject(new Error('old read failed'))
    }
  })
  expect(section().value).toEqual(saved)
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Could not load')
  await act(async () => section().onChange({ ...section().value, suppressWhileViewing: false }))
  expect(mocks.save).toHaveBeenLastCalledWith({ ...saved, suppressWhileViewing: false })
})

it('does not refresh while a save is in flight', async () => {
  await act(async () => {
    renderer = create(createElement(NativeNotificationDeliverySettings, { enabled: true }))
  })
  let finish!: () => void
  mocks.save.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  await act(async () => section().onChange({ ...preferences, sound: true }))
  await act(async () => mocks.appState!('active'))
  expect(mocks.load).toHaveBeenCalledTimes(1)
  await act(async () => finish())
  expect(section().value.sound).toBe(true)
})
