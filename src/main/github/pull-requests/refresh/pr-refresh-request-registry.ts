import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { aliasFromCandidate } from './pr-refresh-candidate-policy'
import type { PRRefreshQueueEntry } from './pr-refresh-queue'

export type PRRefreshOutstandingRead = {
  requestId: string
  slotKey: string
  registrationOrder: number
  identityDigest: string
}

/** Who registered work on a refresh slot; detail recovery waits for or yields to it. */
export type PRRefreshRegistration = {
  slotKey: string
  registrationOrder: number
  /** Visible reports and inherited follow-ups wait; other registrations are new intent. */
  independent: boolean
  aliases: readonly GitHubPRRefreshAlias[]
}

export function prRefreshRequestDigest(
  candidate: GitHubPRRefreshCandidate,
  watch?: PRRefreshQueueEntry['watch']
): string {
  const alias = aliasFromCandidate(candidate)
  return JSON.stringify([
    alias.repoId,
    alias.repoPath,
    alias.branch,
    alias.worktreeId ?? null,
    alias.connectionId ?? null,
    candidate.executionHostId ?? null,
    candidate.localGitOptions?.wslDistro ?? null,
    alias.linkedPRNumber ?? null,
    alias.fallbackPRNumber ?? null,
    alias.fallbackPRSource ?? null,
    alias.currentHeadOid ?? null,
    watch ? [watch.prKey, watch.headSha ?? null] : null
  ])
}

export function queuedRequestId(entry: PRRefreshQueueEntry): string {
  return `q:${entry.queuedAt}`
}

/** Outstanding provider reads, so a recovery ticket awaits real settlement instead of a key-wide status. */
export class PRRefreshRequestRegistry {
  private readonly reads = new Map<string, PRRefreshOutstandingRead>()
  private settleListener: (() => void) | null = null
  private registrationListener: ((registration: PRRefreshRegistration) => void) | null = null

  setListeners(listeners: {
    onSettled: (() => void) | null
    onRegistered: ((registration: PRRefreshRegistration) => void) | null
  }): void {
    this.settleListener = listeners.onSettled
    this.registrationListener = listeners.onRegistered
  }

  register(registration: PRRefreshRegistration): void {
    this.registrationListener?.(registration)
  }

  start(read: PRRefreshOutstandingRead): void {
    this.reads.set(read.requestId, read)
  }

  settle(requestId: string): void {
    if (this.reads.delete(requestId)) {
      this.settleListener?.()
    }
  }

  has(requestId: string): boolean {
    return this.reads.has(requestId)
  }

  readsFor(slotKey: string): PRRefreshOutstandingRead[] {
    return Array.from(this.reads.values()).filter((read) => read.slotKey === slotKey)
  }
}
