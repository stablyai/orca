import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-request-refresh-types'
import type { GitHubOwnerRepo, PRInfo } from '../../../shared/github/pull-request-types'
import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import type { RepoKind } from '../../../shared/repo-types'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/database/journal-host-database'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'

/** A git checkout a watch reads through. Folder workspaces have none, so their chats get no lines. */
export type PRWatchWorkspace = {
  repoId: string
  /** The project's path, as every PR read of it is keyed. */
  repoPath: string
  /** The chat's own worktree, where its commands run. */
  checkoutPath: string
  repoKind: RepoKind
  branch: string
  connectionId: string | null
  wslDistro?: string
}

/** A chat's verified PR head and the checkout branch that published it. */
export type PRPublishedBranch = {
  branch: string
  headSha: string
  pr: ParsedPRKey
  checkoutBranch: string
} & ({ remoteUrl: string; headRepo?: never } | { remoteUrl?: never; headRepo: GitHubOwnerRepo })

export type PRWatchServiceDeps = {
  database: JournalHostDatabase
  /** The chat's git workspace. 'not-git': a folder workspace or a chat outside a worktree, which
   *  never gets lines. Null: gone or not resolvable right now. */
  chatWorkspace: (chatId: string) => Promise<PRWatchWorkspace | 'not-git' | null>
  /** Lets the checkout follow its work to the branch it was published under. Resolves once the
   *  publication is followed or no longer applies; rejects when it should be retried. */
  adoptPublishedBranch: (chatId: string, published: PRPublishedBranch) => Promise<void>
  chatExists: (chatId: string) => boolean
  /** The chat's journal when it is open; closed chats take their lines when they next open. */
  openJournal: (chatId: string) => AgentSessionJournal | null
  /** The chat record's current fence. */
  chatFence: (chatId: string) => number | null
  logger: Pick<StructuredAgentSessionLogger, 'warn'>
  now?: () => number
}

export type ParsedPRKey = { host: string; owner: string; repo: string; number: number }

export function parsePRKey(prKey: string): ParsedPRKey | null {
  const match = /^([^/]+)\/([^/]+)\/([^/#]+)#(\d+)$/u.exec(prKey)
  return match
    ? { host: match[1]!, owner: match[2]!, repo: match[3]!, number: Number(match[4]) }
    : null
}

export function prKeyOf(pr: PRInfo): string | null {
  return pr.prRepo
    ? pullRequestKey({
        forgeHost: pr.prRepo.host ?? 'github.com',
        owner: pr.prRepo.owner,
        repo: pr.prRepo.repo,
        number: pr.number
      })
    : null
}

export function prWatchCandidate(
  workspace: PRWatchWorkspace,
  prNumber: number | null
): GitHubPRRefreshCandidate {
  return {
    cacheKey: `pr-watch::${workspace.checkoutPath}::${prNumber ?? workspace.branch}`,
    repoKind: workspace.repoKind,
    repoId: workspace.repoId,
    repoPath: workspace.repoPath,
    branch: workspace.branch,
    connectionId: workspace.connectionId,
    linkedPRNumber: prNumber,
    ...(workspace.wslDistro ? { localGitOptions: { wslDistro: workspace.wslDistro } } : {})
  }
}
