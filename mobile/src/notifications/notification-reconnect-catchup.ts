import AsyncStorage from '@react-native-async-storage/async-storage'

// Why: the reconnect catch-up watermark + dedup helpers for #8129, extracted
// from mobile-notifications.ts so that file stays under its max-lines budget.
// The highest desktop notification seq this device has delivered is persisted
// per-host so it survives app restarts. On reconnect we send it to
// notifications.getMissedSince as the catch-up watermark — the desktop then
// returns only notifications dispatched after it, so we never re-push a
// notification we already delivered. The in-memory seen-set is a second guard
// against double-delivery for events that arrive on both the live stream and a
// replay (e.g. a brief liveness spell before a reap).
const LAST_SEQ_STORAGE_KEY_PREFIX = 'orca:mobileNotificationsLastSeq:'
// Why (#8591): the watermark alone is meaningless after a desktop restart — the
// counter it indexes is gone. Persist the epoch beside it so a reconnect can tell
// "nothing missed" from "different counter" and refuse to trust a stale cut.
const LAST_EPOCH_STORAGE_KEY_PREFIX = 'orca:mobileNotificationsLastEpoch:'

function lastSeqStorageKey(hostId: string): string {
  return LAST_SEQ_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)
}

function lastEpochStorageKey(hostId: string): string {
  return LAST_EPOCH_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)
}

export async function loadLastSeenSeq(hostId: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(lastSeqStorageKey(hostId))
    const parsed = raw == null ? 0 : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  } catch {
    return 0
  }
}

// Null means "no epoch stored" — a watermark written before this field existed.
export async function loadLastSeenEpoch(hostId: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(lastEpochStorageKey(hostId))
    return raw != null && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

export async function saveLastSeenEpoch(hostId: string, epoch: string): Promise<void> {
  if (!epoch) {
    return
  }
  try {
    await AsyncStorage.setItem(lastEpochStorageKey(hostId), epoch)
  } catch {
    // Best-effort, same trade-off as saveLastSeenSeq: a lost epoch degrades to the
    // seq-only cut, never to a wrong one.
  }
}

export async function saveLastSeenSeq(hostId: string, seq: number): Promise<void> {
  if (!Number.isFinite(seq) || seq <= 0) {
    return
  }
  try {
    await AsyncStorage.setItem(lastSeqStorageKey(hostId), String(seq))
  } catch {
    // Why: persisting the watermark is best-effort. If it fails (or lags), the
    // stored value stays BELOW what we delivered, so a later cold start can
    // re-fetch — and, once the in-memory seen-set is gone, re-show — an already
    // delivered notification. That's the accepted at-least-once trade-off;
    // within a live session the in-memory watermark is authoritative, so only
    // post-restart reconnects are affected.
  }
}

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
  // Highest desktop seq delivered for this host in this app process. Outranks
  // the persisted value, which lags because saveLastSeenSeq is fire-and-forget.
  lastDeliveredSeq: number
  // Counter lifetime lastDeliveredSeq belongs to; null until one is known. A
  // mismatch on reconnect means the desktop restarted and the watermark is void.
  lastDeliveredEpoch: string | null
  seen: ReturnType<typeof createSeenNotificationGuard>
  // False only until the host's first subscription reaches 'ready' — a true cold open.
  connectedBefore: boolean
  // Why: gates catch-up until the persisted watermark has been read once for this
  // host. Per host, not per subscription: a reconnect that races the very first
  // AsyncStorage read would otherwise fetch from seq 0 and re-push the buffer.
  watermarkLoaded: boolean
}

const sessionsByHost = new Map<string, HostNotificationSession>()

export function getHostNotificationSession(hostId: string): HostNotificationSession {
  let session = sessionsByHost.get(hostId)
  if (!session) {
    session = {
      lastDeliveredSeq: 0,
      lastDeliveredEpoch: null,
      seen: createSeenNotificationGuard(),
      connectedBefore: false,
      watermarkLoaded: false
    }
    sessionsByHost.set(hostId, session)
  }
  return session
}

/** Test-only: drop per-host session state so each test starts from a cold open. */
export function resetHostNotificationSessionsForTests(): void {
  sessionsByHost.clear()
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
  if (!epoch || epoch === session.lastDeliveredEpoch) {
    return
  }
  if (session.lastDeliveredEpoch !== null) {
    // A real epoch change (not first observation): the old watermark is void.
    session.lastDeliveredSeq = 0
  }
  session.lastDeliveredEpoch = epoch
  void saveLastSeenEpoch(hostId, epoch)
}

// Why: seed the watermark lazily so subscribe() doesn't block on an AsyncStorage read.
// Only the first subscription for a host needs it; later ones inherit the live value.
export function seedWatermarkFromStorage(session: HostNotificationSession, hostId: string): void {
  if (session.watermarkLoaded) {
    return
  }
  void Promise.all([loadLastSeenSeq(hostId), loadLastSeenEpoch(hostId)]).then(([seq, epoch]) => {
    // Why the epoch comparison: this read can land AFTER 'ready' already adopted a
    // live epoch. If the stored watermark belongs to a different (older) counter,
    // applying it here would silently reinstate exactly the stale cut this fixes.
    // Only a stored epoch matching the live one — or no live one yet — can seed.
    const storedSeqIsCurrent =
      session.lastDeliveredEpoch === null || session.lastDeliveredEpoch === epoch
    if (session.lastDeliveredEpoch === null && epoch !== null) {
      session.lastDeliveredEpoch = epoch
    }
    if (storedSeqIsCurrent) {
      session.lastDeliveredSeq = Math.max(session.lastDeliveredSeq, seq)
    }
    session.watermarkLoaded = true
  })
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
