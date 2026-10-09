import nacl from 'tweetnacl'
import type { PushSendNotification } from './push-gateway-client'
import { SEALED_PUSH_PREFIX, derivePushSealKey, type SealedPushEnvelope } from './push-e2e-seal'

/** The phone's half of push-e2e-seal.ts, so desktop suites can assert on what a phone reads. */
export function openSealedPushNotification(
  notification: PushSendNotification,
  deviceToken: string
): PushSendNotification {
  const { paneKey, ...rest } = notification
  if (!paneKey?.startsWith(SEALED_PUSH_PREFIX)) {
    throw new Error('push notification is not sealed')
  }
  const bundle = Buffer.from(paneKey.slice(SEALED_PUSH_PREFIX.length), 'base64')
  const plaintext = nacl.secretbox.open(
    bundle.subarray(nacl.secretbox.nonceLength),
    bundle.subarray(0, nacl.secretbox.nonceLength),
    derivePushSealKey(deviceToken)
  )
  if (!plaintext) {
    throw new Error('sealed push did not open with this device token')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only reader of an envelope the suite itself sealed.
  const envelope = JSON.parse(Buffer.from(plaintext).toString('utf8')) as SealedPushEnvelope
  return {
    ...rest,
    notificationEpoch: envelope.e,
    ...(envelope.t !== undefined ? { title: envelope.t } : {}),
    ...(envelope.b !== undefined ? { body: envelope.b } : {}),
    ...(envelope.w ? { worktreeId: envelope.w } : {}),
    ...(envelope.n ? { notificationId: envelope.n } : {})
  }
}
