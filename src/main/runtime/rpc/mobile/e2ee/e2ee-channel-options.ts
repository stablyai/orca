import type { RpcBinarySender } from '../../transports/rpc-binary-sender'
import type { E2EEChannel } from './e2ee-channel'
import type { E2EEAuthenticatedDevice } from '../../server/mobile-e2ee-authenticated-device'
import type {
  authenticateMobileE2EE,
  DeviceKeyResolution,
  MobileE2EEAuthFailureCode
} from './mobile-e2ee-auth-validation'
import type { DesktopMobileE2EEV2Context } from './mobile-e2ee-v2-desktop-session'
import type { MobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'

export type E2EEChannelOptions = {
  serverSecretKey: Uint8Array
  resolveAuthenticatedDevice: (
    token: string
  ) => E2EEAuthenticatedDevice | null | { kind: 'unavailable' }
  // Absent: key auth is refused as bad_auth, the same as before device keys existed.
  resolveAuthenticatedDeviceKey?: (deviceId: string) => DeviceKeyResolution<E2EEAuthenticatedDevice>
  onReady: (
    channel: E2EEChannel,
    device: E2EEAuthenticatedDevice,
    revalidate: () => ReturnType<typeof authenticateMobileE2EE<E2EEAuthenticatedDevice>>
  ) =>
    | void
    | { ok: false; code: MobileE2EEAuthFailureCode }
    | { ok: true; device: E2EEAuthenticatedDevice }
  onError: (code: number, reason: string) => void
  runAuthentication?: (action: () => void) => void
  transportContext?: DesktopMobileE2EEV2Context
  requireV2?: boolean
  outboundMemoryBudget?: MobileE2EEOutboundMemoryBudget
}

export type E2EEChannelTextHandler = (
  plaintext: string,
  reply: (response: string) => void,
  sendBinary: RpcBinarySender
) => void
