import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { NotificationGetMissedSinceParams } from '../../../src/shared/rpc-contract/notifications-params'
import { dismissHostPushNotification } from './push-socket-dismissal'
import { deriveHostFingerprint } from './push-host-fingerprint'
const native = vi.hoisted(() => ({ catalog: vi.fn(), presented: vi.fn(), dismiss: vi.fn() }))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: native.catalog }))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: native.presented,
  dismissNotificationAsync: native.dismiss
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

const deliveryIdentity = NotificationGetMissedSinceParams.shape.deliveredPushes.unwrap().element
const retirementSchema = z.object({
  originalEpoch: z.string().min(1),
  restartedEpoch: z.string().min(1),
  event: deliveryIdentity.extend({
    type: z.literal('dismiss'),
    dismissedDelivery: deliveryIdentity
  })
})

async function captureHostRetirement(directory: string) {
  // The host fixture checks against Node types; the phone consumer checks against mobile types.
  const modulePath = fileURLToPath(
    new URL(
      '../../../src/main/runtime/structured-attention-original-delivery.test-fixture.ts',
      import.meta.url
    )
  ).replaceAll('\\', '/')
  const fixture: unknown = await import(/* @vite-ignore */ modulePath)
  if (
    !fixture ||
    typeof fixture !== 'object' ||
    !('captureOriginalDeliveryRetirement' in fixture) ||
    typeof fixture.captureOriginalDeliveryRetirement !== 'function'
  ) {
    throw new Error('host retirement fixture did not load')
  }
  const captured: unknown = fixture.captureOriginalDeliveryRetirement(directory)
  return retirementSchema.parse(captured)
}

it('a restarted host socket withdrawal removes the original native alert and preserves newer identities', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-phone-retirement-'))
  try {
    const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
    native.catalog.mockResolvedValue([{ id: 'host-a', publicKeyB64 }])
    const { originalEpoch, restartedEpoch, event } = await captureHostRetirement(directory)
    const hostFingerprint = deriveHostFingerprint(publicKeyB64)
    const presented = (
      identifier: string,
      notificationEpoch: string,
      notificationSeq: number,
      fingerprint = hostFingerprint
    ) => ({
      request: {
        identifier,
        content: {
          data: {
            hostFingerprint: fingerprint,
            notificationId: 'same',
            notificationEpoch,
            notificationSeq
          }
        }
      }
    })
    native.presented.mockResolvedValue([
      presented('original', originalEpoch, 1),
      presented('newer', originalEpoch, 2),
      presented('restart', restartedEpoch, 1),
      presented('other-host', originalEpoch, 1, 'other')
    ])
    await dismissHostPushNotification(event, 'host-a')
    expect(native.dismiss.mock.calls).toEqual([['original']])
    expect(event.notificationEpoch).toBe(restartedEpoch)
    expect(event.dismissedDelivery?.notificationEpoch).toBe(originalEpoch)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
