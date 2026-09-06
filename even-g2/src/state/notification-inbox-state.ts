// Unit 4: consumes the notifications.subscribe stream into NotificationInboxSlice (spec S8).
import type { HudState, HudStore, NotificationInboxEntry } from './hud-store'
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

/** Finding #13/#4: dedupe by notificationId — a redelivery (getMissedSince overlap with a live
 *  push, or a duplicate retry) replaces the existing entry in place rather than appending a
 *  second copy, which would otherwise let stale/duplicate entries confuse "the current ask".
 *  Finding #4: a retirement tombstone is PERMANENT — a redelivery must never un-retire an entry
 *  just because the fresh copy classifies differently (e.g. its worktree has since left
 *  `permission` entirely, so the fresh copy isn't even kind:'ask' to begin with, and would
 *  otherwise never get re-tombstoned by the reclassifier below). */
function upsertEntry(
  entries: NotificationInboxEntry[],
  entry: NotificationInboxEntry
): NotificationInboxEntry[] {
  const index = entries.findIndex((e) => e.notificationId === entry.notificationId)
  if (index === -1) {
    return pushRingBuffer(entries, entry)
  }
  const next = [...entries]
  next[index] = next[index]!.retiredAsk ? { ...entry, kind: 'info', retiredAsk: true } : entry
  return next
}

/** The most recent (by receivedAt), still-eligible entry for a worktree — the notification tied
 *  to its CURRENT waiting episode, if any has arrived. Shared by `currentAsk` and the
 *  reclassifier so they can never disagree (finding #13). Excludes retired entries (finding #13)
 *  AND entries that predate the worktree's current permission-episode watermark (finding #4) —
 *  an old completion/info notification from a PRIOR episode must never stand in for a new one. */
function latestEligibleEntryForWorktree(
  state: HudState,
  worktreeId: string
): NotificationInboxEntry | null {
  const episodeStartedAt = state.inbox.permissionEpisodeStartedAt?.[worktreeId]
  let latest: NotificationInboxEntry | null = null
  for (const entry of state.inbox.entries) {
    if (entry.worktreeId !== worktreeId || entry.retiredAsk) {
      continue
    }
    if (episodeStartedAt !== undefined && entry.receivedAt < episodeStartedAt) {
      continue
    }
    if (!latest || entry.receivedAt >= latest.receivedAt) {
      latest = entry
    }
  }
  return latest
}

const SYNTHETIC_ASK_PREFIX = 'synthetic-ask:'

/**
 * The one ask the wearer can currently act on — used for BOTH the header's click-through nudge
 * and click routing (nav-context.ts, hud-navigation.ts, screen-view-model.ts) so they can never
 * disagree (HIGH finding #13, "two selectors"). Prefers a real notification tied to the
 * worktree's current permission episode; when no notification has landed yet for a blocked
 * worktree (HIGH finding #14 — an agent waiting on input with no notification is otherwise
 * unreachable), synthesizes one straight from dashboard state instead of leaving it stuck.
 */
export function currentAsk(state: HudState): { notificationId: string; worktreeId: string } | null {
  const permissionRows = state.dashboard.rows.filter((r) => r.status === 'permission')
  if (permissionRows.length === 0) {
    return null
  }
  for (const row of permissionRows) {
    const entry = latestEligibleEntryForWorktree(state, row.worktreeId)
    if (entry) {
      return { notificationId: entry.notificationId, worktreeId: row.worktreeId }
    }
  }
  const row = permissionRows[0]!
  return { notificationId: `${SYNTHETIC_ASK_PREFIX}${row.worktreeId}`, worktreeId: row.worktreeId }
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
  // Finding #4: edge-detects a worktree transitioning INTO `permission` so reclassify can stamp
  // a fresh episode watermark — comparing against the dashboard's CURRENT permission set alone
  // can't tell "just entered" from "has been permission all along".
  private previousPermissionWorktreeIds = new Set<string>()

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
        inbox: {
          ...s.inbox,
          entries: s.inbox.entries.filter((e) => e.notificationId !== data.notificationId)
        }
      }))
      return
    }
    this.noteWatermark(data)
    const entry = this.toEntry(data)
    this.store.update((s) => ({
      ...s,
      inbox: { ...s.inbox, entries: upsertEntry(s.inbox.entries, entry) }
    }))
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
          inbox: { ...s.inbox, entries: upsertEntry(s.inbox.entries, entry) }
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

  /** Re-derives 'ask' on every dashboard/inbox change so exactly one entry per worktree — the
   *  one tied to its CURRENT permission episode (see latestEligibleEntryForWorktree) — is 'ask'.
   *  Any other entry that was 'ask' gets retired (finding #13): either its worktree left
   *  `permission` entirely, or a newer entry took over as the current episode's notification.
   *  Retirement is permanent (`retiredAsk`) so a later, unrelated episode on the same worktree
   *  can't resurrect a historical notification before its own notification arrives.
   *
   *  Finding #4: also stamps `permissionEpisodeStartedAt` the moment a worktree is first OBSERVED
   *  entering `permission` (edge-triggered against `previousPermissionWorktreeIds`), BEFORE
   *  computing which entry is eligible this pass — so an old completion/info notification from a
   *  prior, already-closed episode can never be picked up as the new episode's ask. */
  private reclassifyPermissionAsks(): void {
    this.store.update((s) => {
      const permissionWorktreeIds = new Set(
        s.dashboard.rows.filter((r) => r.status === 'permission').map((r) => r.worktreeId)
      )
      const episodeStartedAt = { ...s.inbox.permissionEpisodeStartedAt }
      let episodeChanged = false
      for (const worktreeId of permissionWorktreeIds) {
        if (!this.previousPermissionWorktreeIds.has(worktreeId)) {
          episodeStartedAt[worktreeId] = (this.inputs.now ?? Date.now)()
          episodeChanged = true
        }
      }
      this.previousPermissionWorktreeIds = permissionWorktreeIds
      const withEpisode: HudState = episodeChanged
        ? { ...s, inbox: { ...s.inbox, permissionEpisodeStartedAt: episodeStartedAt } }
        : s

      const currentEpisodeIds = new Set(
        [...permissionWorktreeIds]
          .map(
            (worktreeId) => latestEligibleEntryForWorktree(withEpisode, worktreeId)?.notificationId
          )
          .filter((id): id is string => id !== undefined)
      )
      let entriesChanged = false
      const entries = withEpisode.inbox.entries.map((entry) => {
        if (!entry.worktreeId) {
          return entry
        }
        if (currentEpisodeIds.has(entry.notificationId)) {
          if (entry.kind === 'ask') {
            return entry
          }
          entriesChanged = true
          return { ...entry, kind: 'ask' as const }
        }
        if (entry.kind !== 'ask') {
          return entry
        }
        entriesChanged = true
        return { ...entry, kind: 'info' as const, retiredAsk: true as const }
      })
      if (!episodeChanged && !entriesChanged) {
        return s
      }
      return { ...withEpisode, inbox: { ...withEpisode.inbox, entries } }
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
