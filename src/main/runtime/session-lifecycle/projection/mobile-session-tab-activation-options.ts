import type { TabPerson } from '../../../bots/team-share/teammate-rules'
import type { RuntimeNavigationTarget } from '../../../../shared/remote-runtime/session-graph/runtime-navigation'
import type { TabActivationIntent } from '../../../../shared/workspace-layout/tab-groups/tab-activation-intent'

export type MobileSessionTabActivationOptions = {
  /** Whom the activate is for, the caller's (rule 4, teammate-rules.ts). */
  person: TabPerson
  beforeActivate?: (target: { sessionId?: string; worktreeId: string }) => void
  includeAgentSenders?: boolean
  notifyClients?: boolean
  clientNavigationId?: string
  navigation?: RuntimeNavigationTarget
  intent?: TabActivationIntent
}
