// Track pending and delivered announcements: journal updates can change renderer-reconstructed IDs.
// Memory-only; after restart, the current status row supplies the fallback ID.
import type { StructuredAttentionOrigin } from '../../shared/agent-session/agent-session-attention'
import type {
  NotificationAttentionAcknowledgement,
  NotificationDispatchRequest,
  StructuredNotificationRead
} from '../../shared/notification-settings-types'
import {
  NotificationAttentionReadFrontiers,
  notificationWasAcknowledged
} from '../../shared/notification-attention-acknowledgement'
const DEFAULT_MAX_SUBJECTS = 256
const DEFAULT_MAX_IDS_PER_SUBJECT = 20

export type AnnouncedNotification = {
  id: string
  origin?: StructuredAttentionOrigin
  paneKey?: string
  pendingOnly?: true
} & Pick<NotificationDispatchRequest, 'worktreeId' | 'executionHost' | 'workspaceExecutionHostId'>

export type AnnouncedNotificationRegistry = {
  record: (
    paneKey: string,
    notificationId: string,
    origin?: StructuredAttentionOrigin,
    workspace?: Pick<
      NotificationDispatchRequest,
      'worktreeId' | 'executionHost' | 'workspaceExecutionHostId'
    >
  ) => readonly AnnouncedNotification[]
  reserveNative: (
    paneKey: string,
    notificationId: string,
    origin?: StructuredAttentionOrigin,
    workspace?: Pick<
      NotificationDispatchRequest,
      'worktreeId' | 'executionHost' | 'workspaceExecutionHostId'
    >
  ) => {
    evicted: readonly AnnouncedNotification[]
    isCurrent: () => boolean
    release: () => void
  }
  takeAcknowledged: (
    acknowledgement: NotificationAttentionAcknowledgement,
    executionHost?: NotificationDispatchRequest['executionHost']
  ) => readonly AnnouncedNotification[]
  hasAnnouncement: (request: Pick<NotificationDispatchRequest, 'notificationId'>) => boolean
  wasRead: (request: NotificationDispatchRequest) => boolean
  hasUnpositionedSubject: (paneKey: string) => boolean
  /** Journal-positioned announcements require a covering read to retire. */
  isBounded: (notificationId: string) => boolean
  /** Take unpositioned announcements and those covered by this read. */
  take: (paneKey: string, read?: StructuredNotificationRead) => readonly AnnouncedNotification[]
}

export function createAnnouncedNotificationRegistry(limits?: {
  maxSubjects?: number
  maxIdsPerSubject?: number
}): AnnouncedNotificationRegistry {
  const maxSubjects = limits?.maxSubjects ?? DEFAULT_MAX_SUBJECTS
  const maxIdsPerSubject = limits?.maxIdsPerSubject ?? DEFAULT_MAX_IDS_PER_SUBJECT
  const idsBySubject = new Map<string, AnnouncedNotification[]>()

  const frontiers = new NotificationAttentionReadFrontiers()
  const takeSelected = (paneKey: string, selects: (entry: AnnouncedNotification) => boolean) => {
    const ids = idsBySubject.get(paneKey) ?? []
    const selected = ids.filter(selects)
    const kept = ids.filter((entry) => !selects(entry))
    if (kept.length > 0) {
      idsBySubject.set(paneKey, kept)
    } else {
      idsBySubject.delete(paneKey)
    }
    return selected
  }
  const record = (
    paneKey: string,
    notificationId: string,
    origin?: StructuredAttentionOrigin,
    workspace?: Pick<
      NotificationDispatchRequest,
      'worktreeId' | 'executionHost' | 'workspaceExecutionHostId'
    >,
    pendingOnly?: true
  ) => {
    const ids = (idsBySubject.get(paneKey) ?? []).filter((entry) => entry.id !== notificationId)
    const { worktreeId, executionHost, workspaceExecutionHostId } = workspace ?? {}
    const entry: AnnouncedNotification = {
      id: notificationId,
      paneKey,
      origin,
      worktreeId,
      executionHost,
      workspaceExecutionHostId,
      ...(pendingOnly ? { pendingOnly } : {})
    }
    ids.push(entry)
    const evicted = ids.slice(0, Math.max(0, ids.length - maxIdsPerSubject))
    // Reinsertion evicts the least recently announced subject.
    idsBySubject.delete(paneKey)
    idsBySubject.set(paneKey, ids.slice(-maxIdsPerSubject))
    if (idsBySubject.size > maxSubjects) {
      const oldest = idsBySubject.keys().next().value
      if (oldest !== undefined) {
        evicted.push(...(idsBySubject.get(oldest) ?? []))
        idsBySubject.delete(oldest)
      }
    }
    return { entry, evicted }
  }

  return {
    hasUnpositionedSubject: (paneKey) =>
      idsBySubject.get(paneKey)?.some((entry) => !entry.origin && !entry.pendingOnly) ?? false,
    hasAnnouncement: (request) =>
      !request.notificationId ||
      [...idsBySubject.values()].some((entries) =>
        entries.some((entry) => entry.id === request.notificationId)
      ),
    wasRead: (request) => frontiers.covers({ ...request, origin: request.structuredOrigin }),
    takeAcknowledged: (acknowledgement, executionHost) => {
      frontiers.accept(acknowledgement, executionHost)
      return [...idsBySubject.keys()].flatMap((paneKey) =>
        takeSelected(paneKey, (entry) =>
          notificationWasAcknowledged(entry, acknowledgement, executionHost)
        )
      )
    },
    record: (paneKey, notificationId, origin, workspace) =>
      record(paneKey, notificationId, origin, workspace).evicted,
    reserveNative: (paneKey, notificationId, origin, workspace) => {
      const existing = idsBySubject.get(paneKey)?.find((entry) => entry.id === notificationId)
      const pendingOnly = existing && !existing.pendingOnly ? undefined : true
      const { entry, evicted } = record(paneKey, notificationId, origin, workspace, pendingOnly)
      return {
        evicted,
        isCurrent: () => idsBySubject.get(paneKey)?.includes(entry) ?? false,
        release: () => {
          takeSelected(paneKey, (candidate) => candidate === entry && !!candidate.pendingOnly)
        }
      }
    },
    isBounded: (notificationId) =>
      [...idsBySubject.values()].some((entries) =>
        entries.some((entry) => entry.id === notificationId && entry.origin !== undefined)
      ),
    take: (paneKey, read) => {
      if (read) {
        frontiers.accept({ reads: [read] }, read.executionHost)
      }
      return takeSelected(
        paneKey,
        (entry) =>
          !entry.origin ||
          Boolean(read && notificationWasAcknowledged(entry, { reads: [read] }, read.executionHost))
      )
    }
  }
}
