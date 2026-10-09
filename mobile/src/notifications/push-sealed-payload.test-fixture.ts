import { sha256 } from '@noble/hashes/sha256'

// Sealed by src/main/runtime/push/push-e2e-seal.ts for token 'f' x 48 and epoch 'epoch-1',
// so these suites prove the phone opens exactly what the desktop sends.
const publicKeyB64 = Buffer.alloc(32, 7).toString('base64')
const hostFingerprint = Buffer.from(sha256(Buffer.alloc(32, 7)))
  .toString('base64url')
  .slice(0, 16)

const PANE_KEY =
  'e2e1:m9M8rTImuLqwmbKvp67ZN8FnvE6fCkooXIDXWslcyilIcOZ9YNvLHOCx6B/1ylZ1M1LPOcEfqzl7BZ5kyXQaGpvSb83tHpcPkoMQF7xsyjkchBr6WBxcFg4HMjF9WKs7vBOFwomhJt6VevUsUUKPfGcCDO7b0JE1OoD4cbh5rBlJBbTzvBi1besgqdn0cA=='

export const SEALED_VECTOR = {
  deviceToken: 'f'.repeat(48),
  paneKey: PANE_KEY,
  /** The FCM data map the gateway builds from the sealed notification. */
  fcmData: {
    hostFingerprint,
    notificationId: 'e2e1.w_xMUGqEqPK_qKRKa75x6ZqDxLJ5mEqA',
    notificationSeq: '1',
    notificationEpoch: 'e2e1.fOE0V63Z-irt7bXgLjTv7ewOZ_-nV6GR',
    source: 'agent-task-complete',
    agentState: 'finished',
    title: 'Agent finished',
    message: '',
    channelId: 'orca-desktop',
    paneKey: PANE_KEY
  }
} as const

export function sealedVectorHost(deviceToken: string = SEALED_VECTOR.deviceToken): {
  id: string
  publicKeyB64: string
  deviceToken: string
} {
  return { id: 'host-1', publicKeyB64, deviceToken }
}
