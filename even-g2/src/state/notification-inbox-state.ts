// Unit 4: consumes the notifications.subscribe stream into NotificationInboxSlice (spec S8).
import type { HudStore, NotificationInboxEntry } from './hud-store'
import type { RpcPort } from '../transport/orca-rpc-wire'

const RING_BUFFER_LIMIT = 20

// Matches the wire shape in spec Appendix B / mobile's local-notification-scheduling.ts.
type DesktopNotificationSource = 'agent-task-complete' | 'terminal-bell' | 'test'

type NotificationReadyEvent = { type: 'ready'; subscriptionId?: string; epoch?: number }

type NotificationPushEvent = {
  type: 'notification'
  source: DesktopNotificationSource
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
}

type NotificationDismissEvent = { type: 'dismiss'; notificationId: string }

type NotificationStreamEvent =
  | NotificationReadyEvent
  | NotificationPushEvent
  | NotificationDismissEvent

function isNotificationStreamEvent(value: unknown): value is NotificationStreamEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    ['ready', 'notification', 'dismiss'].includes((value as { type: unknown }).type as string)
  )
}

export type NotificationInboxInputs = {
  port: RpcPort
  now?: () => number
}

function pushRingBuffer(
  entries: NotificationInboxEntry[],
  entry: NotificationInboxEntry
): NotificationInboxEntry[] {
  const next = [...entries, entry]
  return next.length > RING_BUFFER_LIMIT ? next.slice(next.length - RING_BUFFER_LIMIT) : next
}

/** Consumes notifications.subscribe; maintains a ring buffer of the last 20 entries. */
export class NotificationInboxController {
  private localIdSeq = 0

  constructor(
    private readonly store: HudStore,
    private readonly inputs: NotificationInboxInputs
  ) {}

  start(): () => void {
    return this.inputs.port.subscribe('notifications.subscribe', {}, (data) => this.handle(data))
  }

  private handle(data: unknown): void {
    if (!isNotificationStreamEvent(data)) {
      return
    }
    if (data.type === 'ready') {
      return
    }
    if (data.type === 'dismiss') {
      this.store.update((s) => ({
        ...s,
        inbox: { entries: s.inbox.entries.filter((e) => e.notificationId !== data.notificationId) }
      }))
      return
    }
    const entry = this.toEntry(data)
    this.store.update((s) => ({ ...s, inbox: { entries: pushRingBuffer(s.inbox.entries, entry) } }))
  }

  private toEntry(event: NotificationPushEvent): NotificationInboxEntry {
    const worktreeStatus = event.worktreeId
      ? this.lookupWorktreeStatus(event.worktreeId)
      : undefined
    return {
      notificationId: event.notificationId ?? `local-${++this.localIdSeq}`,
      title: event.title,
      body: event.body,
      worktreeId: event.worktreeId,
      receivedAt: (this.inputs.now ?? Date.now)(),
      kind:
        worktreeStatus === 'permission'
          ? 'ask'
          : event.source === 'agent-task-complete'
            ? 'done'
            : 'info'
    }
  }

  private lookupWorktreeStatus(worktreeId: string) {
    return this.store.getState().dashboard.rows.find((r) => r.worktreeId === worktreeId)?.status
  }
}
