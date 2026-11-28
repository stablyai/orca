import type { CodexSharedServerFrame } from './codex-shared-server-frames'

/** Frames for a thread no chat has claimed yet (e.g. thread/started before thread/start replies). */
const MAX_UNROUTED_FRAMES = 2_000
const UNROUTED_TTL_MS = 30_000
const MAX_LOST_THREADS = 4_096

type Bucket = { frames: CodexSharedServerFrame[]; since: number }

/** Holds unclaimed threads' frames, capped and expiring; `drop` answers any request it gives up. */
export class CodexSharedServerUnrouted {
  private readonly buckets = new Map<string, Bucket>()
  private count = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Expiry waits while a thread open is pending: its early frames are held for its reply. */
  private deferred = false
  /** Threads whose held frames were dropped; a chat that claims one has missed events. */
  private readonly lost = new Set<string>()
  /** A marker was evicted while an open was pending, so until opens settle any claim may have lost
   *  frames. */
  private lostUnknown = false
  /** Markers evicted where a kept chat may own the thread: each restored chat told of fewer may
   *  have lost frames. */
  keptLossEpoch = 0

  constructor(
    private readonly drop: (frame: CodexSharedServerFrame) => void,
    private readonly opensPending: () => boolean,
    /** Expiry may drop a kept chat's frames (a reattach that couldn't list every thread). */
    private readonly expiryLoses: () => boolean = () => false
  ) {}

  hold(threadId: string, frame: CodexSharedServerFrame): void {
    const bucket = this.buckets.get(threadId) ?? { frames: [], since: Date.now() }
    bucket.frames.push(frame)
    this.buckets.set(threadId, bucket)
    this.count += 1
    while (this.count > MAX_UNROUTED_FRAMES) {
      const oldest = this.buckets.keys().next()
      if (oldest.done) {
        this.count = 0
        break
      }
      this.discard(oldest.value, true)
    }
    this.timer ??= setTimeout(() => this.sweep(), UNROUTED_TTL_MS)
    this.timer.unref?.()
  }

  /** The first held frame's seq, for a relayed server's ack floor. */
  floor(): number | null {
    let floor: number | null = null
    for (const bucket of this.buckets.values()) {
      const seq = bucket.frames.find((frame) => typeof frame.seq === 'number')?.seq
      if (typeof seq === 'number' && (floor === null || seq < floor)) {
        floor = seq
      }
    }
    return floor
  }

  /** The frames held for a thread a chat just claimed, in arrival order. */
  take(threadId: string): CodexSharedServerFrame[] {
    const bucket = this.buckets.get(threadId)
    if (!bucket) {
      return []
    }
    this.buckets.delete(threadId)
    this.count -= bucket.frames.length
    return bucket.frames
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.deferred = false
    this.lostUnknown = false
    this.keptLossEpoch = 0
    this.lost.clear()
    this.buckets.clear()
    this.count = 0
  }

  /** Frames were dropped here that a later claim may have missed. */
  get anyLost(): boolean {
    return this.lost.size > 0 || this.lostUnknown || this.keptLossEpoch > 0
  }

  /** Whether frames held for this thread were dropped before anyone claimed it. */
  takeLost(threadId: string): boolean {
    return this.lost.delete(threadId) || this.lostUnknown
  }

  /** `lost`: dropped by the cap, maybe while an open waits for these frames, or expired where a
   *  kept chat may own them. Otherwise expiry runs with no open pending: nobody waits for them. */
  private discard(threadId: string, lost = false): void {
    for (const frame of this.take(threadId)) {
      this.drop(frame)
    }
    if (!lost) {
      return
    }
    this.lost.add(threadId)
    if (this.lost.size > MAX_LOST_THREADS) {
      const oldest = this.lost.values().next()
      if (!oldest.done) {
        this.lost.delete(oldest.value)
        this.lostUnknown ||= this.opensPending()
        this.keptLossEpoch += this.expiryLoses() ? 1 : 0
      }
    }
  }

  /** A thread open settled (its reply claimed its frames first); a deferred expiry runs now. */
  openSettled(): void {
    if (!this.opensPending()) {
      this.lostUnknown = false
    }
    if (this.deferred && !this.opensPending()) {
      this.deferred = false
      this.sweep()
    }
  }

  private sweep(): void {
    this.timer = null
    if (this.opensPending()) {
      this.deferred = true
      return
    }
    const cutoff = Date.now() - UNROUTED_TTL_MS
    for (const [threadId, bucket] of this.buckets) {
      if (bucket.since <= cutoff) {
        this.discard(threadId, this.expiryLoses())
      }
    }
    if (this.buckets.size > 0) {
      this.timer = setTimeout(() => this.sweep(), UNROUTED_TTL_MS)
      this.timer.unref?.()
    }
  }
}
