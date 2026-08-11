// Why: the reconnect catch-up watermark + dedup helpers for #8129, extracted
// from mobile-notifications.ts so that file stays under its max-lines budget.
// The highest desktop notification seq this device has delivered is persisted
// per-host so it survives app restarts. On reconnect we send it to
// notifications.getMissedSince as the catch-up watermark — the desktop then
// returns only notifications dispatched after it, so we never re-push a
// notification we already delivered. The in-memory seen-set is a second guard
// against double-delivery for events that arrive on both the live stream and a
// replay (e.g. a brief liveness spell before a reap).
// Why (#8591): a seq is meaningless without the counter it indexes — after a
// desktop restart that counter is gone. The epoch names the counter's lifetime so
// a reconnect can tell "nothing missed" from "different counter".
//
// Why ONE key holding both, rather than a key each: they are only meaningful as a
// pair. Written separately, a process death between the two writes leaves an epoch
// from one counter beside a seq from another — a pair that looks internally valid
// on the next launch and is therefore trusted, silently cutting real notifications.
// A single JSON value cannot tear that way.
import {
  clearWatermark,
  loadWatermark,
  resetWatermarkPersistenceForTests,
  saveWatermark,
  type LoadedWatermark,
  type PersistedWatermark
} from './notification-watermark-storage'

export { clearWatermark, loadWatermark, saveWatermark }
export type { LoadedWatermark, PersistedWatermark }

// Why: bounded in-memory dedup window for notificationIds/dismiss ids observed
// on the current connection. The desktop already dedupes by seq on replay, but
// a socket that flickers background→foreground→background can deliver an event
// on the live stream and again in a replay; the seen-set guarantees each
// notificationId maps to at most one local push for the connection lifetime.
// Bounded so a long-lived session can't grow without limit — a 2x superset of
// the desktop's 256-entry replay buffer and the 256 scheduled-notification cap.
const RECENTLY_SEEN_CAP = 512

export function createSeenNotificationGuard(): {
  has: (id: string) => boolean
  add: (id: string) => void
  clear: () => void
} {
  const seen = new Set<string>()
  return {
    has(id: string): boolean {
      return seen.has(id)
    },
    add(id: string): void {
      seen.add(id)
      if (seen.size > RECENTLY_SEEN_CAP) {
        // Why: insertion order; the oldest entries are first. Drop one to stay
        // bounded without disturbing the more-recently-relevant keys.
        const first = seen.values().next().value
        if (first !== undefined) {
          seen.delete(first)
        }
      }
    },
    clear(): void {
      seen.clear()
    }
  }
}

// Why (#8591): app/index.tsx tears the notification subscription down on every
// non-'connected' state and builds a fresh one on reconnect, so everything held
// in the subscription closure — the ready counter, the delivered watermark, the
// seen-set — is destroyed exactly when a reconnect needs it. Keeping it per host
// at module scope is what makes the catch-up recognise a reconnect (instead of
// mistaking it for a cold open) and keeps dedup effective across the teardown.
export type HostNotificationSession = {
  retired: boolean
  // Highest desktop seq delivered for this host in this app process. Outranks
  // the persisted value, which lags because saveLastSeenSeq is fire-and-forget.
  lastDeliveredSeq: number
  // Counter lifetime lastDeliveredSeq belongs to; null until one is known. A
  // mismatch on reconnect means the desktop restarted and the watermark is void.
  lastDeliveredEpoch: string | null
  // Highest seq known delivered CONTIGUOUSLY, frozen here while a catch-up is
  // outstanding; null when none has failed. See quarantineCatchUpWatermark.
  catchUpQuarantineSeq: number | null
  seen: ReturnType<typeof createSeenNotificationGuard>
  // False only until the host's first subscription reaches 'ready' — a true cold open.
  connectedBefore: boolean
  // Why (#8591): distinguishes "this device has delivered for this host before"
  // from a first-ever pairing. Only the former may catch up on a cold open — a
  // brand-new pairing fetching from seq 0 would push the desktop's whole buffer
  // at someone who was never subscribed for any of it.
  hadStoredWatermark: boolean
  // Resolves once the persisted read has landed, so the first 'ready' can wait for
  // it instead of deciding catch-up against an unread watermark.
  watermarkSeeded: Promise<void> | null
  // Tail of the per-host delivery chain; see enqueueHostDelivery.
  deliveryTail: Promise<void>
  // notificationIds with a show queued or in flight on that chain; see
  // shouldQueueShowForNotificationId.
  queuedShowIds: Set<string>
}

const sessionsByHost = new Map<string, HostNotificationSession>()
const retirementByHost = new Map<string, Promise<void>>()

export function getHostNotificationSession(hostId: string): HostNotificationSession {
  let session = sessionsByHost.get(hostId)
  if (!session) {
    session = {
      retired: false,
      lastDeliveredSeq: 0,
      lastDeliveredEpoch: null,
      catchUpQuarantineSeq: null,
      seen: createSeenNotificationGuard(),
      connectedBefore: false,
      hadStoredWatermark: false,
      watermarkSeeded: null,
      deliveryTail: Promise.resolve(),
      queuedShowIds: new Set<string>()
    }
    sessionsByHost.set(hostId, session)
  }
  return session
}

/**
 * Run `task` after every delivery already queued for this host, and return a
 * promise for its completion.
 *
 * Why (#8591): the watermark is persisted by whichever delivery advances it, so
 * replay and live delivery running concurrently can persist out of order. A live
 * seq 11 handled while catch-up is still showing seq 6 writes watermark 11, and a
 * process death before 7..10 are shown loses them permanently — the next launch
 * asks the desktop for seq > 11. Serializing per host makes the watermark's
 * monotonic advance mean "everything up to here was actually delivered".
 *
 * A rejected task does not break the chain: the tail swallows the failure so a
 * single bad notification cannot wedge the host's queue forever.
 */
export function enqueueHostDelivery(
  session: HostNotificationSession,
  task: () => Promise<void>
): Promise<void> {
  const run = session.deliveryTail.then(task)
  session.deliveryTail = run.catch(() => {})
  return run
}

/**
 * Claim a notificationId for a queued show, returning false if one is already
 * queued or in flight for it.
 *
 * Why this exists (#8591): showLocalNotification deduped two same-id events by
 * observing that the first was still pending when the second arrived. Serializing
 * deliveries removed that overlap — the first now COMPLETES before the second
 * starts, so the second reads no pending state and schedules a second banner for
 * the same notification. The dedup has to happen where concurrency is still
 * visible, which after serialization is enqueue time rather than delivery time.
 *
 * Only shows are tracked. A dismiss for the same id must still run: it is the
 * mechanism that retires the notification the show created.
 */
export function shouldQueueShowForNotificationId(
  session: HostNotificationSession,
  notificationId: string | undefined
): boolean {
  if (notificationId == null) {
    return true
  }
  if (session.queuedShowIds.has(notificationId)) {
    return false
  }
  session.queuedShowIds.add(notificationId)
  return true
}

/** Release the claim taken by shouldQueueShowForNotificationId once the show settles. */
export function releaseQueuedShowNotificationId(
  session: HostNotificationSession,
  notificationId: string | undefined
): void {
  if (notificationId != null) {
    session.queuedShowIds.delete(notificationId)
  }
}

/** Test-only: drop per-host session state so each test starts from a cold open. */
export function resetHostNotificationSessionsForTests(): void {
  sessionsByHost.clear()
  retirementByHost.clear()
  resetWatermarkPersistenceForTests()
}

/**
 * Freeze the catch-up watermark at the last seq known delivered contiguously,
 * after a catch-up that did not complete.
 *
 * Why: live delivery advances lastDeliveredSeq unconditionally, so an abandoned
 * catch-up otherwise lets the NEXT one ask from above the range it gave up on —
 * the desktop cuts by seq, so those notifications are never replayed and are
 * gone. Lowest wins: an earlier failure's gap is still open.
 */
export function quarantineCatchUpWatermark(
  session: HostNotificationSession,
  hostId: string,
  contiguousSeq: number
): void {
  if (session.retired) {
    return
  }
  session.catchUpQuarantineSeq =
    session.catchUpQuarantineSeq == null
      ? contiguousSeq
      : Math.min(session.catchUpQuarantineSeq, contiguousSeq)
  // Why re-persist: a live event delivered while the catch-up was still in flight
  // already stored a seq above the gap. Clamping only later writes would leave that
  // value on disk, so a restart still resumes past the abandoned range.
  void saveWatermark(hostId, {
    seq: catchUpWatermarkSeq(session),
    epoch: session.lastDeliveredEpoch
  })
}

/** Lift the quarantine once a catch-up completes, persisting what it held back. */
export function resolveCatchUpQuarantine(session: HostNotificationSession, hostId: string): void {
  if (session.retired || session.catchUpQuarantineSeq == null) {
    return
  }
  session.catchUpQuarantineSeq = null
  void saveWatermark(hostId, {
    seq: session.lastDeliveredSeq,
    epoch: session.lastDeliveredEpoch
  })
}

/**
 * The seq a catch-up may ask from and the highest seq safe to persist — the live
 * watermark, clamped to any open gap.
 */
export function catchUpWatermarkSeq(session: HostNotificationSession): number {
  return session.catchUpQuarantineSeq == null
    ? session.lastDeliveredSeq
    : Math.min(session.catchUpQuarantineSeq, session.lastDeliveredSeq)
}

// Why (#8591): the desktop's seq counter restarts at 0 every launch, so a watermark
// from a previous lifetime indexes a counter that no longer exists. Comparing it
// against the fresh counter makes `lastSeenSeq >= seq` true for everything and
// catch-up dies silently until the new process out-dispatches the old watermark.
// Adopting the new epoch means dropping the watermark with it.
export function adoptNotificationEpoch(
  session: HostNotificationSession,
  hostId: string,
  epoch: string | undefined
): void {
  if (session.retired || !epoch || epoch === session.lastDeliveredEpoch) {
    return
  }
  // Why reset on a FIRST observation too (lastDeliveredEpoch === null): a seq seeded
  // from a legacy store carries no epoch, so it cannot be shown to belong to this
  // counter. Keeping it would let a pre-upgrade 57 cut the new counter's 1..57 —
  // the exact #8591 failure, reached through the upgrade path instead of a restart.
  session.lastDeliveredSeq = 0
  // Why clear `seen`: its keys are seq-derived, and terminal-bell notifications have
  // no notificationId at all (they key on `seq:N` alone). Across a restart the new
  // counter re-issues those same low seqs, so a stale `seq:1` would silently drop
  // the new counter's first bell. The dedup window belongs to one counter lifetime.
  session.seen.clear()
  // The quarantined gap indexed the dead counter; the watermark it guarded is gone too.
  session.catchUpQuarantineSeq = null
  session.lastDeliveredEpoch = epoch
  void saveWatermark(hostId, { seq: 0, epoch })
}

// Why: seed the watermark lazily so subscribe() doesn't block on an AsyncStorage read.
// Only the first subscription for a host needs it; later ones inherit the live value.
/**
 * Ms the persisted read may block catch-up and live delivery before they proceed
 * without it. AsyncStorage normally answers in single-digit ms; a read that has
 * not landed by now is assumed wedged.
 *
 * Why a bound at all (#8591): every delivery awaits this promise, so a read that
 * never settles silently disables notifications for the host for the whole app
 * lifetime — no error, no banner, nothing to see. Proceeding unseeded is strictly
 * better: the watermark stays 0, so catch-up over-fetches and the seen-set
 * de-duplicates, which costs a redundant request instead of every notification.
 */
const WATERMARK_SEED_TIMEOUT_MS = 3000

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      }
    )
  })
}

export function seedWatermarkFromStorage(session: HostNotificationSession, hostId: string): void {
  if (session.watermarkSeeded) {
    return
  }
  const seeded = loadWatermark(hostId).then(({ seq, epoch, stored }) => {
    if (session.retired) {
      return
    }
    // Why the record's existence and not `seq > 0`: adoptNotificationEpoch persists
    // `{seq: 0, epoch}` when it voids a watermark, so a device that HAS delivered for
    // this host reloads as seq 0. Keying on the seq would read that as a first pairing
    // and skip catch-up for the whole window the epoch change was meant to recover.
    if (stored) {
      session.hadStoredWatermark = true
    }
    // Why the epoch comparison: this read can land AFTER 'ready' already adopted a
    // live epoch. If the stored watermark belongs to a different (older) counter,
    // applying it here would silently reinstate exactly the stale cut this fixes.
    // A null stored epoch is a legacy watermark of unknown provenance — it may only
    // seed while no live epoch is known, and adopting one later resets it.
    if (session.lastDeliveredEpoch === null || session.lastDeliveredEpoch === epoch) {
      session.lastDeliveredSeq = Math.max(session.lastDeliveredSeq, seq)
      if (session.lastDeliveredEpoch === null && epoch !== null) {
        session.lastDeliveredEpoch = epoch
      }
    }
  })
  // The late seed still applies when it eventually lands; the timeout only stops it
  // from holding delivery hostage. `seeded` never rejects into the awaiters.
  session.watermarkSeeded = withTimeout(seeded, WATERMARK_SEED_TIMEOUT_MS)
}

// Why (#8591): sessions live at module scope so they survive the subscription
// teardown a reconnect performs. Nothing else drops them, so a host that is removed
// and re-paired would retain its session and up to 512 seen keys until app restart.
export function forgetHostNotificationSession(hostId: string): void {
  sessionsByHost.delete(hostId)
}

// Why bounded: unpair awaits this on the UI thread, so a delivery that never settles (a
// wedged expo scheduling promise) would hang the button with no recovery. Overrunning the
// drain is safe because `retired` is already set — every watermark write checks it, so a
// late delivery cannot persist past the clear below.
const RETIREMENT_DELIVERY_DRAIN_TIMEOUT_MS = 2_000
const RETIREMENT_WATERMARK_CLEAR_TIMEOUT_MS = 2_000

async function drainHostDeliveries(session: HostNotificationSession | undefined): Promise<void> {
  if (!session) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      session.deliveryTail,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RETIREMENT_DELIVERY_DRAIN_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function retireHostNotificationState(hostId: string): Promise<void> {
  const existing = retirementByHost.get(hostId)
  if (existing) {
    return existing
  }
  const session = sessionsByHost.get(hostId)
  if (session) {
    session.retired = true
  }
  // Invalidate prior writers before waiting for delivery; the serialized clear still
  // runs after any write already inside AsyncStorage.
  const watermarkClear = clearWatermark(hostId)
  const retirement = (async () => {
    await Promise.all([
      drainHostDeliveries(session),
      withTimeout(watermarkClear, RETIREMENT_WATERMARK_CLEAR_TIMEOUT_MS)
    ])
    if (!session || sessionsByHost.get(hostId) === session) {
      sessionsByHost.delete(hostId)
    }
  })()
  retirementByHost.set(hostId, retirement)
  void retirement.finally(() => {
    if (retirementByHost.get(hostId) === retirement) {
      retirementByHost.delete(hostId)
    }
  })
  return retirement
}

// Why: key for the replay dedup guard. Uses notificationId when present, but
// disambiguates by seq so a legitimate live re-delivery of the same id at a
// NEW seq (content refresh, allowed by the existing behaviour) is NOT treated
// as a duplicate, while a replay re-returning the SAME id+seq already delivered
// live is suppressed. Replay events always carry a seq (the desktop assigns
// one), so the guard is effective on the reconnect path.
export function seenKeyForEvent(event: {
  notificationId?: string
  notificationSeq?: number
}): string | null {
  const id = event.notificationId
  if (id != null && event.notificationSeq != null) {
    return `id:${id}#${event.notificationSeq}`
  }
  if (id != null) {
    return `id:${id}`
  }
  if (event.notificationSeq != null) {
    return `seq:${event.notificationSeq}`
  }
  return null
}
