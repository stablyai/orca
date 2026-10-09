import type {
  ScheduledMessage,
  ScheduledMessageChanges,
  ScheduledMessageDraft,
  ScheduledMessagesSnapshot
} from '../../shared/scheduled-message-types'

export type ScheduledMessagesApi = {
  /** Hydrates after a renderer reload; main pushes every change after. */
  get: () => Promise<ScheduledMessagesSnapshot>
  add: (draft: ScheduledMessageDraft) => Promise<ScheduledMessage | null>
  /** Edit text and/or timing. Also the reschedule path for a missed row. */
  update: (messageId: string, changes: ScheduledMessageChanges) => Promise<void>
  delete: (messageId: string) => Promise<void>
  sendNow: (messageId: string) => Promise<void>
  onUpdate: (callback: (snapshot: ScheduledMessagesSnapshot) => void) => () => void
}
