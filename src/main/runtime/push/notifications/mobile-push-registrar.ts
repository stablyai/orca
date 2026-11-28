import type { LiveActivityRegistration } from '../../../../shared/notifications/live-activity-contract'
import type {
  MobilePushTestResult,
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../../../shared/notifications/mobile-push-contract'
import type { NotificationPushCoverageRequest as PushCoverageRequest } from '../../../../shared/rpc-contract/notifications/notifications-params'

/** The desktop push service, once it exists; absent on hosts that never started one. */
export type MobilePushRegistrar = {
  registerLiveActivity?(
    deviceId: string,
    input: LiveActivityRegistration
  ): Promise<{ registered: boolean }>
  unregisterLiveActivity?(deviceId: string, activityId: string): void
  resolveLiveActivitySession?(
    deviceId: string,
    activityId: string,
    sessionId: string
  ): { worktreeId: string; paneKey: string } | null
  test(deviceId: string): Promise<MobilePushTestResult>
  register(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult>
  unregister(deviceId: string): Promise<{ unregistered: boolean }>
  coveredTokenDigests(request: PushCoverageRequest): Promise<string[]>
}
