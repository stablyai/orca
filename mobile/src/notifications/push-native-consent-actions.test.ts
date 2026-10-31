import { ports, T2, lifetime, detach, drain } from './push-native-consent-lifetime.test-fixture'
import { pushOwnerRpcPort as client } from './push-owner-native-ports.test-fixture'
import { expect, it, vi } from 'vitest'
import { AppState } from 'react-native'

it.each(['native', 'consent'] as const)(
  'extends saved/missing eleven-action ownership boundaries through the %s stage',
  async (stage) => {
    const actions = [
      'disable',
      'stop',
      'restart',
      'detach',
      're-pair',
      'remove',
      'token',
      'renewal',
      'background',
      'filter-failure',
      'consent-failure'
    ] as const
    for (const kind of ['saved', 'missing'] as const) {
      for (const action of actions) {
        vi.resetModules()
        const registration = await import('./push-registration')
        const native = await import('./push-native-preparation')
        const consent = await import('./push-consent-preparation')
        const context = `${kind}/${stage}/${action}`
        const currentToken = stage === 'native' && action === 'token'
        if (currentToken) {
          ports.native = { ...T2, token: 'b'.repeat(64) }
        }
        const initialToken = ports.native
        const nativeCalls = ports.nativeCalls
        ports.storage.set('orca:pushServiceNotificationsEnabled', 'true')
        if (kind === 'saved') {
          const { mobilePushRouteKey } = await import('./push-route-declaration')
          const saved = mobilePushRouteKey(() => true)
          try {
            await drain()
            await expect(saved.result, context).resolves.toMatchObject({ status: 'ready' })
          } finally {
            saved.release()
          }
          expect(ports.keys.size, context).toBeGreaterThan(0)
        } else {
          ports.keys.clear()
        }
        registration.resetPushRegistrationForTests()
        const keyRead = (ports.keyRead = Promise.withResolvers<void>())
        let release: (() => void) | undefined
        try {
          if (stage === 'native') {
            ports.nativeHold = Promise.withResolvers<string>()
          }
          lifetime.stop = registration.startPushTokenSync()
          await drain()
          if (stage === 'consent') {
            ports.consentHold = { mode: 'reply', gate: Promise.withResolvers<void>() }
          }
          const connection = client()
          release = registration.attachPushRegistration('actions', connection)
          detach.push(release)
          await drain()
          const listener = ports.listener
          expect(registration.pushRegistrationSnapshotForTests().preparations, context).toBe(1)
          let rollback: (() => void) | undefined
          if (action === 'disable') {
            await registration.setRemotePushEnabled(false)
          } else if (action === 'stop' || action === 'restart') {
            lifetime.stop()
            if (action === 'restart') {
              lifetime.stop = registration.startPushTokenSync()
            }
          } else if (action === 'detach') {
            release()
          } else if (action === 'remove' || action === 're-pair') {
            rollback = await registration.unregisterPushForRemovedHost('actions')
            if (action === 're-pair') {
              rollback()
            }
          } else if (action === 'token') {
            ports.native = T2
            ports.listener?.(T2)
          } else if (action === 'renewal') {
            ports.foreground?.('active')
          } else if (action === 'background') {
            AppState.currentState = 'background'
            ports.foreground?.('background')
          } else {
            const storage = (await import('@react-native-async-storage/async-storage')).default
            const save = vi
              .spyOn(storage, 'setItem')
              .mockRejectedValueOnce(new Error('local persistence failed'))
            const local =
              action === 'consent-failure'
                ? registration.setRemotePushEnabled(false)
                : registration.setNotificationDeliveryPreferences({
                    onlyWhenDesktopAway: false,
                    sound: false,
                    suppressWhileViewing: true
                  })
            await expect(local, context).rejects.toThrow('local persistence failed')
            save.mockRestore()
          }
          await drain()
          const registerCalls = () =>
            connection.sendRequest.mock.calls.filter(
              ([method]) => method === 'notifications.registerPush'
            )
          if (currentToken) {
            const expected = {
              ...T2,
              filter: { onlyWhenDesktopAway: true, sound: true }
            }
            expect(
              registerCalls().map(([, params]) => params),
              context
            ).toEqual([expected])
            expect(ports.nativeCalls - nativeCalls, context).toBe(1)
            expect(native.pushNativeSnapshotForTests(), context).toEqual({
              physical: 1,
              assignment: 0,
              entries: 0,
              timers: 0,
              callables: 0
            })
            ports.nativeHold?.resolve(initialToken.token)
            await ports.nativeHold?.promise
            await drain()
            expect(
              registerCalls().map(([, params]) => params),
              `${context}: late T1`
            ).toEqual([expected])
            expect(ports.nativeCalls - nativeCalls, context).toBe(1)
            expect(native.pushNativeSnapshotForTests().physical, context).toBe(0)
          } else {
            expect(registerCalls(), context).toHaveLength(0)
          }
          expect(
            registration.pushRegistrationSnapshotForTests().preparations,
            context
          ).toBeLessThanOrEqual(1)
          lifetime.stop()
          release()
          expect(native.pushNativeSnapshotForTests(), context).toMatchObject({
            entries: 0,
            timers: 0,
            assignment: 0,
            callables: 0
          })
          expect(consent.pushConsentSnapshotForTests(), context).toMatchObject({
            selected: 0,
            queued: 0,
            root: 0,
            hosts: 0,
            callables: 0
          })
          listener?.(initialToken)
          await drain()
          expect(registerCalls(), `${context}: retired listener`).toHaveLength(currentToken ? 1 : 0)
        } finally {
          lifetime.stop?.()
          release?.()
          ports.consentHold?.gate.resolve()
          ports.nativeHold?.resolve(initialToken.token)
          keyRead.resolve()
          await keyRead.promise
          await ports.consentHold?.gate.promise
          await ports.nativeHold?.promise
          ports.consentHold = undefined
          ports.nativeHold = undefined
          ports.keyRead = undefined
          await drain()
          registration.resetPushRegistrationForTests()
          AppState.currentState = 'active'
        }
      }
    }
  }
)
