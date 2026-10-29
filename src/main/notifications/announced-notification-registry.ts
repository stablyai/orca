// Record actual announcements by subject: journal updates can change renderer-reconstructed IDs.
// Memory-only; after restart, the current status row supplies the fallback ID.
import {
  attentionOriginWasRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionRead
} from '../../shared/agent-session-attention'
const DEFAULT_MAX_SUBJECTS = 256
const DEFAULT_MAX_IDS_PER_SUBJECT = 20

export type AnnouncedNotification = { id: string; origin?: StructuredAttentionOrigin }

export type AnnouncedNotificationRegistry = {
  record: (paneKey: string, notificationId: string, origin?: StructuredAttentionOrigin) => void
  /** Journal-positioned announcements require a covering read to retire. */
  isBounded: (notificationId: string) => boolean
  /** Take unpositioned announcements and those covered by this read. */
  take: (paneKey: string, read?: StructuredAttentionRead) => readonly AnnouncedNotification[]
}

export function createAnnouncedNotificationRegistry(limits?: {
  maxSubjects?: number
  maxIdsPerSubject?: number
}): AnnouncedNotificationRegistry {
  const maxSubjects = limits?.maxSubjects ?? DEFAULT_MAX_SUBJECTS
  const maxIdsPerSubject = limits?.maxIdsPerSubject ?? DEFAULT_MAX_IDS_PER_SUBJECT
  const idsBySubject = new Map<string, AnnouncedNotification[]>()

  return {
    record: (paneKey, notificationId, origin) => {
      const ids = (idsBySubject.get(paneKey) ?? []).filter((entry) => entry.id !== notificationId)
      ids.push({ id: notificationId, origin })
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
    }
  }
}
