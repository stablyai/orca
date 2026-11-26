import type { RuntimeNavigationTarget } from '../../../../shared/remote-runtime/session-graph/runtime-navigation'
import type { TabActivationIntent } from '../../../../shared/workspace-layout/tab-groups/tab-activation-intent'

export type MobileSessionTabActivationOptions = {
  beforeActivate?: (target: { sessionId?: string; worktreeId: string }) => void
  includeAgentSenders?: boolean
  notifyClients?: boolean
  clientNavigationId?: string
  navigation?: RuntimeNavigationTarget
  intent?: TabActivationIntent
}
