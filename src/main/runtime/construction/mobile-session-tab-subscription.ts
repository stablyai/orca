import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export type MobileSessionTabSubscription = {
  listener: (
    snapshot: RuntimeMobileSessionTabsResult,
    changeSequence: number,
    delivery?: 'reconciliation'
  ) => void
  clientNavigationId?: string
  clientKind?: 'mobile' | 'runtime'
  observation?: 'caller'
  acceptsWorktree?: (worktree: string) => boolean
  /** Reads chat tabs only, so a terminal pane's hook status builds no frame for it. */
  scope?: 'agent-sessions'
}
