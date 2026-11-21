import type { CodexSharedServerFrame } from './codex-shared-server-frames'

/** Frames for a thread no chat has claimed yet (e.g. thread/started before thread/start replies). */
const MAX_UNROUTED_FRAMES = 2_000
const UNROUTED_TTL_MS = 30_000

type Bucket = { frames: CodexSharedServerFrame[]; since: number }

/** Holds unclaimed threads' frames, capped and expiring; `drop` answers any request it gives up. */
export class CodexSharedServerUnrouted {
  private readonly buckets = new Map<string, Bucket>()
  private count = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Expiry waits while a thread open is pending: its early frames are held for its reply. */
  private deferred = false

  constructor(
    private readonly drop: (frame: CodexSharedServerFrame) => void,
    private readonly opensPending: () => boolean
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
      this.discard(oldest.value)
    }
    this.timer ??= setTimeout(() => this.sweep(), UNROUTED_TTL_MS)
    this.timer.unref?.()
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
    this.buckets.clear()
    this.count = 0
  }

  private discard(threadId: string): void {
    for (const frame of this.take(threadId)) {
      this.drop(frame)
    }
  }

  /** A thread open settled (its reply claimed its frames first); a deferred expiry runs now. */
  openSettled(): void {
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
        this.discard(threadId)
      }
    }
    if (this.buckets.size > 0) {
      this.timer = setTimeout(() => this.sweep(), UNROUTED_TTL_MS)
      this.timer.unref?.()
    }
  }
}
