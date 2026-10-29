import { describe, expect, it } from 'vitest'
import { PushDeviceRegistrationRequestSchema } from './device-registration-messages.js'
import {
  PushHostChallengeRequestSchema,
  PushHostChallengeResponseSchema,
  PushHostSessionRequestSchema,
  PushHostSessionResponseSchema
} from './host-auth-messages.js'

const KEY_B64 = Buffer.alloc(32, 1).toString('base64')
const NONCE_B64 = Buffer.alloc(24, 2).toString('base64')
const SESSION_TOKEN = Buffer.alloc(32, 3).toString('base64url')
const FINGERPRINT = 'abcdefghijklmnop'
const APNS_TOKEN = 'a'.repeat(64)
const FCM_TOKEN = 'cQ1abcDEF_gh:APA91bZZ-zz0123456789abcdefghijklmnopqrstuvwxyz'

describe('host authentication schemas', () => {
  it('accepts a well formed challenge round trip', () => {
    expect(
      PushHostChallengeRequestSchema.safeParse({ v: 1, hostPublicKeyB64: KEY_B64 }).success
    ).toBe(true)
    expect(
      PushHostChallengeResponseSchema.safeParse({
        challengeId: 'challenge-1',
        gatewayEphemeralPublicKeyB64: KEY_B64,
        nonceB64: NONCE_B64,
        ciphertextB64: Buffer.alloc(96, 5).toString('base64'),
        expiresAt: 1_700_000_010_000
      }).success
    ).toBe(true)
    expect(
      PushHostSessionRequestSchema.safeParse({
        v: 1,
        challengeId: 'challenge-1',
        proofB64: KEY_B64
      }).success
    ).toBe(true)
    expect(
      PushHostSessionResponseSchema.safeParse({
        sessionToken: SESSION_TOKEN,
        expiresAt: 1_700_086_400_000,
        hostFingerprint: FINGERPRINT
      }).success
    ).toBe(true)
  })

  it('rejects unknown keys, wrong versions, and mis-sized keys', () => {
    expect(
      PushHostChallengeRequestSchema.safeParse({
        v: 1,
        hostPublicKeyB64: KEY_B64,
        extra: true
      }).success
    ).toBe(false)
    expect(
      PushHostChallengeRequestSchema.safeParse({ v: 2, hostPublicKeyB64: KEY_B64 }).success
    ).toBe(false)
    expect(
      PushHostChallengeRequestSchema.safeParse({
        v: 1,
        hostPublicKeyB64: Buffer.alloc(31, 1).toString('base64')
      }).success
    ).toBe(false)
    expect(
      PushHostSessionResponseSchema.safeParse({
        sessionToken: SESSION_TOKEN,
        expiresAt: 1_700_086_400_000,
        hostFingerprint: 'short'
      }).success
    ).toBe(false)
  })
})

describe('device registration schemas', () => {
  it('requires an apns environment and a hex token for ios', () => {
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-1',
        platform: 'ios',
        token: APNS_TOKEN,
        apnsEnvironment: 'sandbox'
      }).success
    ).toBe(true)
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-1',
        platform: 'ios',
        token: APNS_TOKEN
      }).success
    ).toBe(false)
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-1',
        platform: 'ios',
        token: 'not-hex',
        apnsEnvironment: 'production'
      }).success
    ).toBe(false)
  })

  it('rejects an apns environment on android and accepts an fcm token', () => {
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-2',
        platform: 'android',
        token: FCM_TOKEN
      }).success
    ).toBe(true)
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-2',
        platform: 'android',
        token: FCM_TOKEN,
        apnsEnvironment: 'sandbox'
      }).success
    ).toBe(false)
  })
})
