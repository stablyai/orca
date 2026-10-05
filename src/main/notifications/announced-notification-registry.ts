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
const DEFAULT_MAX_SUBJECTS = 256
const DEFAULT_MAX_IDS_PER_SUBJECT = 20

export type AnnouncedNotificationRegistry = {
  record: (paneKey: string, notificationId: string) => void
  /** Every id announced for this subject since the last take; the entry is dropped. */
  take: (paneKey: string) => readonly string[]
}

export function createAnnouncedNotificationRegistry(limits?: {
  maxSubjects?: number
  maxIdsPerSubject?: number
}): AnnouncedNotificationRegistry {
  const maxSubjects = limits?.maxSubjects ?? DEFAULT_MAX_SUBJECTS
  const maxIdsPerSubject = limits?.maxIdsPerSubject ?? DEFAULT_MAX_IDS_PER_SUBJECT
  const idsBySubject = new Map<string, string[]>()

  return {
    record: (paneKey, notificationId) => {
      const ids = (idsBySubject.get(paneKey) ?? []).filter((id) => id !== notificationId)
      ids.push(notificationId)
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
    take: (paneKey) => {
      const ids = idsBySubject.get(paneKey) ?? []
      idsBySubject.delete(paneKey)
      return ids
    }
  }
}
