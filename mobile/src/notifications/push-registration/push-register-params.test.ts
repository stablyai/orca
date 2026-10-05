import { expect, it } from 'vitest'
import {
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  NOTIFICATIONS_REMOTE_PUSH_SEALED_RUNTIME_CAPABILITY
} from '../../../../src/shared/mobile-runtime-capabilities'
import { hostSealsPushes, pushRegisterParams } from './push-register-params'

const FILTER = {}

it('asks for sealed pushes only from a host that can seal them, and only on Android', () => {
  const both = [
    NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
    NOTIFICATIONS_REMOTE_PUSH_SEALED_RUNTIME_CAPABILITY
  ]
  expect(hostSealsPushes(both)).toBe(true)
  expect(hostSealsPushes([NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY])).toBe(false)

  const android = { platform: 'android' as const, token: 'fcm-token' }
  expect(pushRegisterParams(android, FILTER, true)).toMatchObject({ sealedContent: 'e2e1' })
  const old = pushRegisterParams(android, FILTER, false)
  expect(old).toMatchObject({ platform: 'android' })
  expect(old).not.toHaveProperty('sealedContent')
  const ios = pushRegisterParams(
    { platform: 'ios', token: 'apns-token', apnsEnvironment: 'production' },
    FILTER,
    true
  )
  expect(ios).toMatchObject({ platform: 'ios' })
  expect(ios).not.toHaveProperty('sealedContent')
})
