import { describe, expect, it } from 'vitest'
import {
  ApnsEnvironmentSchema,
  PushDeviceListResponseSchema,
  PushDeviceRegistrationRequestSchema,
  PushDeviceRegistrationResponseSchema,
  PushNotificationFilterSchema
} from './device-registration-messages.js'
import {
  PushErrorResponseSchema,
  PushHostChallengeRequestSchema,
  PushHostChallengeResponseSchema,
  PushHostSessionRequestSchema,
  PushHostSessionResponseSchema
} from './host-auth-messages.js'
import { PUSH_DEFAULTS, PUSH_LIMITS } from './push-limits.js'
import {
  PushSendRequestSchema,
  PushSendResponseSchema,
  PushSendStatusSchema
} from './send-messages.js'

const KEY_B64 = Buffer.alloc(32, 1).toString('base64')
const NONCE_B64 = Buffer.alloc(24, 2).toString('base64')
const SESSION_TOKEN = Buffer.alloc(32, 3).toString('base64url')
const FINGERPRINT = 'abcdefghijklmnop'
const APNS_TOKEN = 'a'.repeat(64)
const FCM_TOKEN = 'cQ1abcDEF_gh:APA91bZZ-zz0123456789abcdefghijklmnopqrstuvwxyz'

function notification(): Record<string, unknown> {
  return {
    notificationId: 'note-1',
    notificationSeq: 4,
    notificationEpoch: '5c9e9a1e-0000-4000-8000-000000000000',
    source: 'agent-task-complete',
    agentState: 'needs-input',
    title: 'Agent needs input',
    body: 'Waiting on your answer',
    worktreeId: 'wt-1'
  }
}

describe('push contract limits', () => {
  it('locks the normative limits the desktop and gateway both assume', () => {
    expect(PUSH_LIMITS).toMatchObject({
      titleMaxChars: 80,
      bodyMaxChars: 180,
      maxRegistrationIdsPerSend: 20,
      hostSendsPerRollingHour: 60,
      registrationSendsPerRollingDay: 200,
      coalesceWindowMs: 3_000,
      challengeTtlMs: 10_000,
      clockSkewToleranceMs: 30_000,
      sessionTtlMs: 86_400_000,
      sendLogRetentionMs: 90_000_000,
      notificationTtlSeconds: 14_400,
      apnsCollapseIdMaxBytes: 64
    })
    expect(PUSH_DEFAULTS.apnsTopic).toBe('com.stably.orca.mobile')
    expect(PUSH_DEFAULTS.fcmProjectId).toBe('onorca-cloud')
    expect(PUSH_DEFAULTS.androidChannelId).toBe('orca-desktop')
  })
})

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
    expect(PushHostChallengeRequestSchema.safeParse({ v: 2, hostPublicKeyB64: KEY_B64 }).success)
      .toBe(false)
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

  it('names only the error codes the gateway may return', () => {
    expect(PushErrorResponseSchema.safeParse({ error: 'session_expired' }).success).toBe(true)
    expect(PushErrorResponseSchema.safeParse({ error: 'teapot' }).success).toBe(false)
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
        apnsEnvironment: 'sandbox',
        filter: { sources: ['agent-task-complete'], agentStates: ['needs-input'] }
      }).success
    ).toBe(true)
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-1',
        platform: 'ios',
        token: APNS_TOKEN,
        filter: { sources: [], agentStates: [] }
      }).success
    ).toBe(false)
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-1',
        platform: 'ios',
        token: 'not-hex',
        apnsEnvironment: 'production',
        filter: { sources: [], agentStates: [] }
      }).success
    ).toBe(false)
  })

  it('rejects an apns environment on android and accepts an fcm token', () => {
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-2',
        platform: 'android',
        token: FCM_TOKEN,
        filter: { sources: ['plugin', 'terminal-bell'], agentStates: [] }
      }).success
    ).toBe(true)
    expect(
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'device-2',
        platform: 'android',
        token: FCM_TOKEN,
        apnsEnvironment: 'sandbox',
        filter: { sources: [], agentStates: [] }
      }).success
    ).toBe(false)
  })

  it('rejects duplicate filter entries and unknown filter keys', () => {
    expect(
      PushNotificationFilterSchema.safeParse({
        sources: ['plugin', 'plugin'],
        agentStates: []
      }).success
    ).toBe(false)
    expect(
      PushNotificationFilterSchema.safeParse({
        sources: [],
        agentStates: ['finished'],
        worktrees: []
      }).success
    ).toBe(false)
    expect(ApnsEnvironmentSchema.safeParse('adhoc').success).toBe(false)
  })

  it('shapes the registration and list responses', () => {
    expect(PushDeviceRegistrationResponseSchema.safeParse({ registrationId: 'reg-1' }).success)
      .toBe(true)
    expect(
      PushDeviceListResponseSchema.safeParse({
        devices: [
          { registrationId: 'reg-1', deviceId: 'device-1', platform: 'ios', dead: false }
        ]
      }).success
    ).toBe(true)
    expect(
      PushDeviceListResponseSchema.safeParse({
        devices: [{ registrationId: 'reg-1', deviceId: 'device-1', platform: 'ios' }]
      }).success
    ).toBe(false)
  })
})

describe('send schemas', () => {
  it('accepts a batch at the registration cap and a terminal bell without an id', () => {
    const ids = Array.from({ length: PUSH_LIMITS.maxRegistrationIdsPerSend }, (_, i) => `reg-${i}`)
    expect(
      PushSendRequestSchema.safeParse({ v: 1, registrationIds: ids, notification: notification() })
        .success
    ).toBe(true)
    const { notificationId: _dropped, ...bell } = notification()
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...bell, source: 'terminal-bell', agentState: null }
      }).success
    ).toBe(true)
  })

  it('rejects an oversized batch, over-long copy, and unknown notification keys', () => {
    const ids = Array.from(
      { length: PUSH_LIMITS.maxRegistrationIdsPerSend + 1 },
      (_, i) => `reg-${i}`
    )
    expect(
      PushSendRequestSchema.safeParse({ v: 1, registrationIds: ids, notification: notification() })
        .success
    ).toBe(false)
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...notification(), title: 'x'.repeat(PUSH_LIMITS.titleMaxChars + 1) }
      }).success
    ).toBe(false)
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...notification(), body: 'x'.repeat(PUSH_LIMITS.bodyMaxChars + 1) }
      }).success
    ).toBe(false)
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...notification(), coalescedCount: 2 }
      }).success
    ).toBe(false)
    expect(PushSendRequestSchema.safeParse({ v: 1, registrationIds: [], notification: notification() }).success)
      .toBe(false)
  })

  it('locks the send result statuses', () => {
    expect(PushSendStatusSchema.options).toEqual(['queued', 'dead', 'rate_limited', 'error'])
    expect(
      PushSendResponseSchema.safeParse({
        results: [{ registrationId: 'reg-1', status: 'queued' }]
      }).success
    ).toBe(true)
    expect(
      PushSendResponseSchema.safeParse({
        results: [{ registrationId: 'reg-1', status: 'sent' }]
      }).success
    ).toBe(false)
  })
})
