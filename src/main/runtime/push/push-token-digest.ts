import { createHash } from 'node:crypto'
import type { MobilePushRegisterInput } from '../../../shared/notifications/mobile-push-contract'

/** Every host hashes the phone's native token the same way, so the digest names one phone across hosts. */
export function mobilePushTokenDigest(
  input: Pick<MobilePushRegisterInput, 'platform' | 'token'>
): string {
  return createHash('sha256').update(`${input.platform}\0${input.token}`).digest('base64url')
}
