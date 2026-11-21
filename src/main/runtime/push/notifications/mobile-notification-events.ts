import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AgentStatusState } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { StructuredAttentionOrigin } from '../../../../shared/agent-session/view/agent-session-attention'
import type {
  MobilePushTestResult,
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../../../shared/notifications/mobile-push-contract'
import type { DeliveredNotificationIdentity } from '../../../../shared/notifications/mobile-notification-identity'
import type { NotificationPushCoverageRequest as PushCoverageRequest } from '../../../../shared/rpc-contract/notifications/notifications-params'

export type MobileNotificationDispatchEvent = {
  type: 'notification'
  legacySocketAllowed?: boolean
  desktopAllowed?: boolean
  desktopAway?: boolean
  emittedAt?: number
  source: 'agent-task-complete' | 'terminal-bell' | 'test' | 'plugin'
  title: string
  body: string
  worktreeId?: string
  workspaceExecutionHostId?: ExecutionHostId | null
  /** The pane the phone opens on tap; old phones ignore it and open the workspace's default tab. */
  paneKey?: string
  /** See `NotificationDispatchRequest.executionHost`; old phones ignore it and open the desktop's. */
  executionHost?: `runtime:${string}`
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
  // Additive state distinguishes input-needed from finished in push; old clients ignore it.
  agentState?: AgentStatusState
  /** See `NotificationDispatchRequest.attentionKey`: cooldowns key on it instead of the workspace. */
  attentionKey?: string
  structuredOrigin?: StructuredAttentionOrigin
}

export type MobileNotificationDismissEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
  dismissedDelivery?: DeliveredNotificationIdentity
}

export type MobileNotificationEvent =
  | MobileNotificationDispatchEvent
  | MobileNotificationDismissEvent

/** The desktop push service, once it exists; absent on hosts that never started one. */
export type MobilePushRegistrar = {
  test(deviceId: string): Promise<MobilePushTestResult>
  register(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult>
  unregister(deviceId: string): Promise<{ unregistered: boolean }>
  coveredTokenDigests(request: PushCoverageRequest): Promise<string[]>
}

/** Host news for its owner with no agent turn behind it; `id` keys its cooldown and its phone notice. */
export type OwnerNotice = {
  id: string
  title: string
  body: string
  /** Where a phone opens on tap. */
  worktreeId?: string
  paneKey?: string
  /** False when the phone already hears it another way, like a failed turn's own push. */
  phone?: false
  /** False when this host's windows already show it, like an access request's toast. */
  desktop?: false
}
