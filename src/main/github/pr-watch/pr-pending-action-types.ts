import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/database/journal-host-database'
import type { PushRemote } from './pr-chat-action-recorder'
import type { PRPendingActionRow, PRPendingObligation } from './pr-pending-actions'
import type { PRChatAction } from './pr-watch-tables'
import type { ParsedPRKey, PRWatchWorkspace } from './pr-watch-types'

/** One verified action and how its head is kept: moved already, or not kept (ownership only). */
export type PRVerifiedAction = {
  action: PRChatAction
  candidate: GitHubPRRefreshCandidate
  movedAt: number | null
}

export type PRPendingActionResumeDeps = {
  database: JournalHostDatabase
  chatExists: (chatId: string) => boolean
  /** 'not-git': a folder workspace or a chat outside a worktree, terminal at once. Null: retry. */
  chatWorkspace: (chatId: string) => Promise<PRWatchWorkspace | 'not-git' | null>
  repositories: (
    workspace: PRWatchWorkspace
  ) => Promise<readonly { owner: string; repo: string; host?: string }[]>
  /** The push's `To` target through the checkout's config; null while that can't be decided. */
  resolvePushRemote: (
    workspace: PRWatchWorkspace,
    evidence: Extract<PRPendingObligation, { kind: 'pushed' }>['evidence']
  ) => Promise<PushRemote | 'unknown' | null>
  readAfterPush: (candidate: GitHubPRRefreshCandidate) => void
  resolveCommitSha: (
    candidate: GitHubPRRefreshCandidate,
    pr: ParsedPRKey,
    abbreviated: string
  ) => Promise<string | null>
  isCommitInPRHead: (
    candidate: GitHubPRRefreshCandidate,
    pr: ParsedPRKey,
    sha: string,
    headSha: string
  ) => Promise<boolean>
  /** Decided obligations, verified or terminal: their actions and progress saved in one commit. */
  settle: (row: PRPendingActionRow, indices: number[], verified: PRVerifiedAction[]) => void
  logger: Pick<StructuredAgentSessionLogger, 'warn'>
  now: () => number
}
