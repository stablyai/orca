// Record actual announcements by subject: journal updates can change renderer-reconstructed IDs.
// Memory-only; after restart, the current status row supplies the fallback ID.
import {
  attentionOriginWasRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionRead
} from '../../shared/agent-session/agent-session-attention'
const DEFAULT_MAX_SUBJECTS = 256
const DEFAULT_MAX_IDS_PER_SUBJECT = 20

export type AnnouncedNotification = {
  id: string
  origin?: StructuredAttentionOrigin
  /** Announcements scoped to a worktree, so a whole-worktree acknowledgement can retire them. */
  worktreeId?: string
}

export type AnnouncedNotificationRegistry = {
  record: (
    paneKey: string,
    notificationId: string,
    origin?: StructuredAttentionOrigin,
    worktreeId?: string
  ) => void
  /** Journal-positioned announcements require a covering read to retire. */
  isBounded: (notificationId: string) => boolean
  /** Take unpositioned announcements and those covered by this read. */
  take: (paneKey: string, read?: StructuredAttentionRead) => readonly AnnouncedNotification[]
  /** Take every announcement scoped to this worktree; a CLI ack reads the whole worktree. */
  takeByWorktree: (
    worktreeId: string
  ) => readonly { paneKey: string; entries: readonly AnnouncedNotification[] }[]
}

export function createAnnouncedNotificationRegistry(limits?: {
  maxSubjects?: number
  maxIdsPerSubject?: number
}): AnnouncedNotificationRegistry {
  const maxSubjects = limits?.maxSubjects ?? DEFAULT_MAX_SUBJECTS
  const maxIdsPerSubject = limits?.maxIdsPerSubject ?? DEFAULT_MAX_IDS_PER_SUBJECT
  const idsBySubject = new Map<string, AnnouncedNotification[]>()

  return {
    record: (paneKey, notificationId, origin, worktreeId) => {
      const ids = (idsBySubject.get(paneKey) ?? []).filter((entry) => entry.id !== notificationId)
      ids.push({ id: notificationId, origin, worktreeId })
      // Reinsertion evicts the least recently announced subject.
      idsBySubject.delete(paneKey)
      idsBySubject.set(paneKey, ids.slice(-maxIdsPerSubject))
      if (idsBySubject.size > maxSubjects) {
        const oldest = idsBySubject.keys().next().value
        if (oldest !== undefined) {
          idsBySubject.delete(oldest)
        }
      }
    },
    isBounded: (notificationId) =>
      [...idsBySubject.values()].some((entries) =>
        entries.some((entry) => entry.id === notificationId && entry.origin !== undefined)
      ),
    take: (paneKey, read) => {
      const ids = idsBySubject.get(paneKey) ?? []
      // Legacy hosts have no journal position or prompt races.
      const selected = ids.filter(
        (entry) => !entry.origin || (read && attentionOriginWasRead(entry.origin, read))
      )
      const kept = ids.filter((entry) => !selected.includes(entry))
      if (kept.length > 0) {
        idsBySubject.set(paneKey, kept)
      } else {
        idsBySubject.delete(paneKey)
      }
      return selected
    },
    takeByWorktree: (worktreeId) => {
      const taken: { paneKey: string; entries: AnnouncedNotification[] }[] = []
      for (const [paneKey, ids] of idsBySubject) {
        const matching = ids.filter((entry) => entry.worktreeId === worktreeId)
        if (matching.length === 0) {
          continue
        }
        const kept = ids.filter((entry) => entry.worktreeId !== worktreeId)
        if (kept.length > 0) {
          idsBySubject.set(paneKey, kept)
        } else {
          idsBySubject.delete(paneKey)
        }
        taken.push({ paneKey, entries: matching })
      }
      return taken
    }
  }
}

// The renderer dismiss path and RPC-side worktree acknowledgements both need the
// registry that registerNotificationHandlers records into. Registration owns the
// instance; this accessor exposes the live one to the rest of the main process.
let sessionRegistry: AnnouncedNotificationRegistry | null = null

export function setSessionAnnouncedNotificationRegistry(
  registry: AnnouncedNotificationRegistry | null
): void {
  sessionRegistry = registry
}

export function sessionAnnouncedNotifications(): AnnouncedNotificationRegistry | null {
  return sessionRegistry
}
