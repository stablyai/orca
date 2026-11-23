import type { AuthenticatedPrincipalBinding } from '../../rpc/server/pairing/device-entry'
import type {
  LiveActivityContent,
  LiveActivityRegistration
} from '../../../../shared/notifications/live-activity-contract'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export type TrackedActivity = {
  input: LiveActivityRegistration
  principal: AuthenticatedPrincipalBinding
  expiresAt: number
  content?: LiveActivityContent
  frame?: RuntimeMobileSessionTabsResult
  sent?: string
  sentAt: number
  timestamp: number
  pending?: Promise<void>
  nextAt: number
  dirty: boolean
  sawPane: boolean
  stop: () => void
}
