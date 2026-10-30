import {
  pushOwnerNativePorts,
  pushOwnerRpcPort as client
} from './push-owner-native-ports.test-fixture'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ownerCleanup } from '../../../cloud/apps/push/src/push-owner-integration.test-fixture'
import { AppState, Platform } from 'react-native'
import type * as Registration from './push-registration'
import type * as Native from './push-native-preparation'
import type * as Consent from './push-consent-preparation'
export let registration: typeof Registration
export let native: typeof Native
export let consent: typeof Consent
export const ports = pushOwnerNativePorts()
vi.mock('../transport/rpc-client', () => ({
  connect: () => {
    if (!ports.session) {
      throw new Error('Missing external RPC session port')
    }
    return ports.session
  }
}))
vi.mock('expo-file-system', () => ({
  Directory: class {
    readonly exists = false
    readonly uri: string
    constructor(...paths: string[]) {
      this.uri = paths.join('/')
    }
  },
  File: class {
    readonly exists = false
  },
  Paths: { cache: 'file:///native-lifetime-cache' }
}))
export const T2 = { platform: 'ios', token: 'c'.repeat(64), apnsEnvironment: 'production' } as const
export const lifetime: { stop?: () => void } = {}
export const detach: (() => void)[] = []
export const drain = () => vi.advanceTimersByTimeAsync(0)
export function attach(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const connection = client()
    detach.push(registration.attachPushRegistration(`host-${i}`, connection))
    return connection
  })
}
beforeEach(async () => {
  vi.resetModules()
  registration = await import('./push-registration')
  native = await import('./push-native-preparation')
  consent = await import('./push-consent-preparation')
  vi.useFakeTimers()
  Object.assign(Platform, { OS: 'ios' })
  AppState.currentState = 'active'
  ports.storage.clear()
  ports.keys.clear()
  ports.storage.set('orca:pushServiceNotificationsEnabled', 'true')
  ports.nativeCalls = 0
  ports.listenerRemovals = 0
  ports.consentCalls = 0
  ports.nativeGets.length = 0
  ports.channelCalls.length = 0
  ports.consentResults.length = 0
  ports.native = { platform: 'ios', token: 'b'.repeat(64), apnsEnvironment: 'production' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 }))
  )
})
afterEach(async () => {
  const cleanup = ownerCleanup()
  await cleanup.run(() => lifetime.stop?.())
  lifetime.stop = undefined
  for (const release of detach.splice(0)) {
    await cleanup.run(release)
  }
  for (const release of [
    () => ports.consentHold?.gate.resolve(),
    () => ports.channelHold?.resolve(),
    () => ports.nativeHold?.resolve(ports.native.token)
  ]) {
    await cleanup.run(release)
  }
  ports.consentHold = undefined
  ports.channelHold = undefined
  ports.nativeHold = undefined
  await cleanup.run(drain)
  await cleanup.run(registration.resetPushRegistrationForTests)
  await cleanup.run(() =>
    expect(native.pushNativeSnapshotForTests()).toEqual({
      physical: 0,
      assignment: 0,
      entries: 0,
      timers: 0,
      callables: 0
    })
  )
  await cleanup.run(() =>
    expect(consent.pushConsentSnapshotForTests()).toEqual({
      physical: 0,
      selected: 0,
      queued: 0,
      root: 0,
      hosts: 0,
      callables: 0
    })
  )
  await cleanup.run(() => expect(ports.listener).toBeUndefined())
  await cleanup.run(() => vi.restoreAllMocks())
  await cleanup.run(() => vi.unstubAllGlobals())
  await cleanup.run(() => vi.useRealTimers())
  cleanup.finish()
})
