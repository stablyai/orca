import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRWatchStorage } from './pr-watch-storage'
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
  database: PRWatchStorage
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
  settle: (
    row: PRPendingActionRow,
    indices: number[],
    verified: PRVerifiedAction[]
  ) => Promise<void>
  logger: Pick<StructuredAgentSessionLogger, 'warn'>
  now: () => number
}

export type PendingPush = {
  candidate: GitHubPRRefreshCandidate
  update: { branch: string; newSha: string | null }
  remote: PushRemote | null
  late: boolean
  deadline: number
  resolving: boolean
  finishing?: Promise<void>
  noPRReads: number
  finish: (result: PRVerifiedAction | null) => Promise<void>
  row: PRPendingActionRow
}

export const pendingActionTiming = {
  PUSH_READ_INTERVAL_MS: 20_000,
  // After the verify deadline, one or two reads decide a late push.
  LATE_PUSH_WINDOW_MS: 40_000,
  // GitHub shows a push on its PR within this; after it, two reads finding no PR end the push.
  NO_PR_LAG_MS: 2 * 60_000,
  NO_PR_READS: 2,
  RETRY_BASE_MS: 15_000,
  RETRY_MAX_MS: 30 * 60_000
}
