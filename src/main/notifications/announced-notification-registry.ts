/**
 * The notification ids main actually announced — a desktop banner shown or a mobile alert sent —
 * per subject pane, until an acknowledgement of that subject retires them.
 *
 * Why by subject rather than by an id the renderer rebuilds: an id is minted from the status row's
 * `stateStartedAt`, and that field moves after the fact (settling pushes the working start into
 * history, and a settled structured row is re-stamped by later journal rows such as a cancel's
 * status note). Main is where the announcement happens, so main is where the record belongs.
 *
 * In memory only, like the banner registry it sits beside; after a restart the renderer's id
 * rebuilt from the current row is the fallback.
 */
import {
  attentionOriginWasRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionRead
} from '../../shared/agent-session-attention'
const DEFAULT_MAX_SUBJECTS = 256
const DEFAULT_MAX_IDS_PER_SUBJECT = 20

type AnnouncedNotification = { id: string; origin?: StructuredAttentionOrigin }

export type AnnouncedNotificationRegistry = {
  record: (paneKey: string, notificationId: string, origin?: StructuredAttentionOrigin) => void
  /** Whether this id was announced with a journal position, so only a covering read retires it. */
  isBounded: (notificationId: string) => boolean
  /** Removes every announcement without a journal position, and those with one this read covers. */
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
      // Re-insert so eviction drops the subject least recently announced, not the first ever seen.
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
      // No position means a host older than journal cursors, which raises no prompts to race.
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
