import type {
  MobilePushRegisterInput,
  MobilePushRegistration
} from '../../../shared/notifications/mobile-push-contract'
import type { DeviceRegistry } from '../rpc/server/pairing/device-registry'
import { mobilePushTokenDigest } from './push-token-digest'

export type PushRegistrationStorageFailure = 'not_mobile' | 'registration_storage_failed'

/** Returns the refusal reason when a gateway-accepted registration cannot be stored. */
export function storePushRegistration(
  registry: DeviceRegistry,
  input: MobilePushRegisterInput,
  registrationId: string
): PushRegistrationStorageFailure | null {
  try {
    const stored = registry.setPushRegistration(
      input.deviceId,
      registrationRecord(input, registrationId)
    )
    // False means the device was removed or left mobile scope while the gateway call was in flight.
    return stored ? null : 'not_mobile'
  } catch (error) {
    console.warn('[push] Failed to persist a push registration:', error)
    return 'registration_storage_failed'
  }
}

function registrationRecord(
  input: MobilePushRegisterInput,
  registrationId: string
): MobilePushRegistration {
  return {
    registrationId,
    filter: input.filter,
    expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
    tokenDigest: mobilePushTokenDigest(input)
  }
}
