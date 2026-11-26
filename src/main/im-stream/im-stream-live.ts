// One IM message edited in place while a turn runs: rendered from the turn's view, throttled, and
// dropped to "progress notice + final answer" once the platform stops taking edits.
import { ImStreamThrottle, type ImStreamTimer } from './im-stream-throttle'
import type { ImTurnView } from './im-stream-turn-view'

/** Why a message stopped taking live edits. `failed` is a write that kept failing for no named reason. */
export type ImStreamDegrade = 'permission' | 'rate_limited' | 'expired' | 'failed'

const FAILURES_BEFORE_DEGRADE = 3

export type ImLiveStreamDeps = {
  /** Writes one in-progress frame of the same message. */
  write: (frame: string) => Promise<void>
  render: (view: ImTurnView) => string
  /** What a failed write means: null is a blip worth another frame. Absent: every failure is one. */
  classify?: (error: unknown) => ImStreamDegrade | null
  /** Blips in a row before the stream gives up as `failed`; 1 gives up at the first. */
  failuresBeforeDegrade?: number
  /** No frame is written at or after this time (the platform's edit window). */
  deadline?: number
  /** What the message shows already, so rendering it again writes nothing. */
  shown?: string
  onDegraded: (reason: ImStreamDegrade, error?: unknown) => void
  now?: () => number
  gapMs?: number
  timer?: ImStreamTimer
}

export class ImLiveStream {
  private state: 'live' | 'degraded' | 'closed' = 'live'
  private reason: ImStreamDegrade | null = null
  private lastFrame: string | undefined
  private failures = 0
  private readonly throttle: ImStreamThrottle<string>
  private readonly now: () => number
  private readonly deadline: number

  constructor(private readonly deps: ImLiveStreamDeps) {
    this.now = deps.now ?? Date.now
    this.deadline = deps.deadline ?? Number.POSITIVE_INFINITY
    this.lastFrame = deps.shown
    this.throttle = new ImStreamThrottle<string>(
      async (frame) => {
        await deps.write(frame)
        this.failures = 0
      },
      (error) => this.failed(error),
      {
        ...(deps.gapMs !== undefined ? { gapMs: deps.gapMs } : {}),
        now: this.now,
        ...(deps.timer ? { timer: deps.timer } : {})
      }
    )
  }

  get degraded(): ImStreamDegrade | null {
    return this.reason
  }

  get live(): boolean {
    return this.state === 'live' && this.now() < this.deadline
  }

  get counts(): ImStreamThrottle<string>['counts'] {
    return this.throttle.counts
  }

  update(view: ImTurnView): void {
    if (this.state === 'live') {
      this.offer(this.deps.render(view))
    }
  }

  /** A frame of its own in place of the turn's progress, at the same pace. */
  note(frame: string): void {
    if (this.state === 'live') {
      this.offer(frame)
    }
  }

  degrade(reason: ImStreamDegrade, error?: unknown): void {
    if (this.state !== 'live') {
      return
    }
    this.state = 'degraded'
    this.reason = reason
    void this.throttle.close()
    this.deps.onDegraded(reason, error)
  }

  /** Stops live frames and waits out the one in flight, so the final write is the last. */
  async close(): Promise<void> {
    if (this.state === 'live') {
      this.state = 'closed'
    }
    await this.throttle.close()
  }

  private offer(frame: string): void {
    if (this.now() >= this.deadline) {
      this.degrade('expired')
      return
    }
    if (frame !== this.lastFrame) {
      this.lastFrame = frame
      this.throttle.offer(frame)
    }
  }

  private failed(error: unknown): void {
    const reason = this.deps.classify?.(error) ?? null
    this.failures++
    if (reason) {
      this.degrade(reason, error)
    } else if (this.failures >= (this.deps.failuresBeforeDegrade ?? FAILURES_BEFORE_DEGRADE)) {
      this.degrade('failed', error)
    }
  }
}
