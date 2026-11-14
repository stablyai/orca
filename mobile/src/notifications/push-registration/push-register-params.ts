import type {
  MobilePushFilter,
  MobilePushRegisterInput
} from '../../../../src/shared/mobile-push-contract'
import { NOTIFICATIONS_REMOTE_PUSH_SEALED_RUNTIME_CAPABILITY } from '../../../../src/shared/mobile-runtime-capabilities'
import type { MobilePushToken } from './push-token'

// Older hosts reject an unknown registerPush field, so it is sent only when advertised.
export function hostSealsPushes(capabilities: readonly string[]): boolean {
  return capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_SEALED_RUNTIME_CAPABILITY)
}

export function pushRegisterParams(
  token: MobilePushToken,
  filter: MobilePushFilter,
  hostSeals: boolean
): Omit<MobilePushRegisterInput, 'deviceId'> {
  return {
    platform: token.platform,
    token: token.token,
    ...(token.apnsEnvironment ? { apnsEnvironment: token.apnsEnvironment } : {}),
    filter,
    // Android only: iOS shows APNs alerts itself and this app has no service extension to open them.
    ...(hostSeals && token.platform === 'android' ? { sealedContent: 'e2e1' as const } : {})
  }
}
