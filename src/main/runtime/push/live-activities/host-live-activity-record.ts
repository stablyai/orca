import type { AuthenticatedPrincipalBinding } from '../../rpc/server/pairing/device-entry'
import type {
  LiveActivityHostContent,
  LiveActivityRegistration
} from '../../../../shared/notifications/live-activity-contract'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export type TrackedActivity = {
  input: LiveActivityRegistration
  principal: AuthenticatedPrincipalBinding
  expiresAt: number
  content?: LiveActivityHostContent
  frames: Map<string, RuntimeMobileSessionTabsResult>
  initialized: boolean
  authoritative: boolean
  censusAuthoritative: boolean
  censusAt: number
  collecting?: Map<string, RuntimeMobileSessionTabsResult>
  bootstrapReady?: boolean
  sequence: number
  sent?: string
  sentAt: number
  timestamp: number
  pending?: Promise<void>
  nextAt: number
  dirty: boolean
  stop: () => void
}
