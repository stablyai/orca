// Unit 4: consumes the notifications.subscribe stream into NotificationInboxSlice (spec S8).
import type { HudStore, NotificationInboxEntry } from './hud-store'
import type { RpcPort, RpcSuccess } from '../transport/orca-rpc-wire'

const RING_BUFFER_LIMIT = 20

// Matches the wire shape in spec Appendix B / mobile's local-notification-scheduling.ts.
type DesktopNotificationSource = 'agent-task-complete' | 'terminal-bell' | 'test'

// notifications.ts:62 always sends epoch (a UUID string) on 'ready'; optional here only so a
// pre-epoch host doesn't fail parsing.
type NotificationReadyEvent = { type: 'ready'; subscriptionId?: string; epoch?: string }

// Shared fields between a live push and a notifications.getMissedSince replay item — see
// runtime-mobile-notification-controller.ts's MobileNotificationDispatchEvent.
type NotificationEventFields = {
  source?: DesktopNotificationSource
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
}

type NotificationPushEvent = { type: 'notification' } & NotificationEventFields

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

/** Loose validation for notifications.getMissedSince items — degrade safely on a malformed one. */
function isMissedNotificationItem(value: unknown): value is NotificationEventFields {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { title: unknown }).title === 'string' &&
    typeof (value as { body: unknown }).body === 'string'
  )
}

type NotificationGetMissedSinceResult = {
  notifications?: unknown[]
  epoch?: string
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

/** Consumes notifications.subscribe; maintains a ring buffer of the last 20 entries.
 *
 * Reclassification (HIGH fix): classification happens once, from whatever dashboard snapshot
 * exists when the notification arrives. If the notification wins the race against the first
 * worktree.ps poll, a real permission ask would otherwise be stuck as 'info'/'done' forever.
 * The controller re-derives 'ask' for retained entries every time the dashboard slice changes.
 *
 * Reconnect backfill (MEDIUM fix): the transport resends the notifications.subscribe request on
 * every reconnect using the same subscription object (orca-socket-handshake.ts's
 * runAuthenticatedBootstrap), which re-emits a 'ready' event to this controller's still-active
 * onData callback. A 'ready' after the first one is therefore the resubscribe-after-auth signal;
 * on it we call notifications.getMissedSince with our seq/epoch watermark to backfill whatever
 * was dispatched while disconnected. Degrades to a no-op if the host lacks the method/metadata.
 */
export class NotificationInboxController {
  private localIdSeq = 0
  private seenReadyBefore = false
  private lastSeenSeq = 0
  private lastSeenEpoch: string | null = null

  constructor(
    private readonly store: HudStore,
    private readonly inputs: NotificationInboxInputs
  ) {}

  start(): () => void {
    const unsubscribePort = this.inputs.port.subscribe('notifications.subscribe', {}, (data) =>
      this.handle(data)
    )
    // Re-derive 'ask' for entries whose worktree only later reports 'permission' (race fix).
    const unsubscribeStore = this.store.subscribe(() => this.reclassifyPermissionAsks())
    return () => {
      unsubscribePort()
      unsubscribeStore()
    }
  }

  private handle(data: unknown): void {
    if (!isNotificationStreamEvent(data)) {
      return
    }
    if (data.type === 'ready') {
      this.handleReady(data)
      return
    }
    if (data.type === 'dismiss') {
      this.store.update((s) => ({
        ...s,
        inbox: { entries: s.inbox.entries.filter((e) => e.notificationId !== data.notificationId) }
      }))
      return
    }
    this.noteWatermark(data)
    const entry = this.toEntry(data)
    this.store.update((s) => ({ ...s, inbox: { entries: pushRingBuffer(s.inbox.entries, entry) } }))
  }

  private handleReady(event: NotificationReadyEvent): void {
    const isResubscribe = this.seenReadyBefore
    this.seenReadyBefore = true
    if (!isResubscribe) {
      // Cold start: nothing to backfill, just adopt the counter lifetime.
      if (event.epoch) {
        this.lastSeenEpoch = event.epoch
      }
      return
    }
    void this.backfillMissed()
  }

  private async backfillMissed(): Promise<void> {
    try {
      const response = await this.inputs.port.sendRequest('notifications.getMissedSince', {
        lastSeenSeq: this.lastSeenSeq,
        epoch: this.lastSeenEpoch ?? undefined
      })
      if (!response.ok) {
        return // host omits the method (older wire) or rejected it — degrade to live-only
      }
      const result = (response as RpcSuccess).result as NotificationGetMissedSinceResult
      const missed = Array.isArray(result?.notifications) ? result.notifications : []
      for (const item of missed) {
        if (!isMissedNotificationItem(item)) {
          continue // malformed replay item — skip rather than crash the backfill
        }
        this.noteWatermark(item)
        const entry = this.toEntry(item)
        this.store.update((s) => ({
          ...s,
          inbox: { entries: pushRingBuffer(s.inbox.entries, entry) }
        }))
      }
      if (typeof result?.epoch === 'string') {
        this.lastSeenEpoch = result.epoch
      }
    } catch {
      // Transport failure mid-backfill: offline notifications stay missed until the next
      // reconnect's 'ready' retries — never worse than today's no-backfill behavior.
    }
  }

  private noteWatermark(event: NotificationEventFields): void {
    if (typeof event.notificationSeq === 'number') {
      this.lastSeenSeq = Math.max(this.lastSeenSeq, event.notificationSeq)
    }
    if (typeof event.notificationEpoch === 'string') {
      this.lastSeenEpoch = event.notificationEpoch
    }
  }

  private reclassifyPermissionAsks(): void {
    this.store.update((s) => {
      let changed = false
      const entries = s.inbox.entries.map((entry) => {
        if (entry.kind === 'ask' || !entry.worktreeId) {
          return entry
        }
        const status = s.dashboard.rows.find((r) => r.worktreeId === entry.worktreeId)?.status
        if (status !== 'permission') {
          return entry
        }
        changed = true
        return { ...entry, kind: 'ask' as const }
      })
      return changed ? { ...s, inbox: { entries } } : s
    })
  }

  private toEntry(event: NotificationEventFields): NotificationInboxEntry {
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
