// One IM-started turn's live message: rendered from the journal's view of the turn, throttled, and
// dropped to "progress notice + final answer" once the platform stops taking edits.
import { ImStreamThrottle, type ImStreamTimer } from './im-stream-throttle'
import { maskImText, type ImStep } from './im-stream-step'
import type { ImTurnView } from './im-stream-turn-view'

export type ImStreamDegrade = 'permission' | 'rate_limited' | 'expired' | 'failed'

export const IM_THINKING_CHARS = 280
export const IM_SHOWN_STEPS = 6
const FAILURES_BEFORE_DEGRADE = 3

const STEP_MARK: Record<ImStep['state'], string> = { running: '⏳', done: '✅', failed: '❌' }

export type ImProgressFormat = {
  /** How the platform shows thinking; a platform without a thinking block gets a quote. */
  thinking: (text: string) => string
  /** Shown before any thinking, step or answer arrives. */
  waiting: string
  /** Shown above the steps when earlier ones were left out. */
  earlierSteps: (count: number) => string
}

function tail(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max + 1).trimStart()}`
}

/** The in-progress message text: thinking (cut to its newest part), the newest steps, the answer so far. */
export function renderImProgress(view: ImTurnView, format: ImProgressFormat): string {
  const parts: string[] = []
  const thinking = tail(maskImText(view.thinking), IM_THINKING_CHARS)
  if (thinking) {
    parts.push(format.thinking(thinking))
  }
  if (view.steps.length > 0) {
    const shown = view.steps.slice(-IM_SHOWN_STEPS)
    const lines = shown.map((step) => `${STEP_MARK[step.state]} ${step.summary}`)
    if (view.steps.length > shown.length) {
      lines.unshift(format.earlierSteps(view.steps.length - shown.length))
    }
    parts.push(lines.join('\n'))
  }
  if (view.answer.trim()) {
    parts.push(view.answer)
  }
  return parts.length > 0 ? parts.join('\n\n') : format.waiting
}

type LiveDeps = {
  /** Writes one in-progress frame of the same message. */
  write: (text: string) => Promise<void>
  /** What a failed write means: null is a blip worth another frame. */
  classify: (error: unknown) => ImStreamDegrade | null
  render: (view: ImTurnView) => string
  /** No in-progress frame is written at or after this time (the platform's edit window). */
  deadline: number
  onDegraded: (reason: ImStreamDegrade) => void
  now?: () => number
  gapMs?: number
  timer?: ImStreamTimer
}

export class ImLiveStream {
  private state: 'live' | 'degraded' | 'closed' = 'live'
  private reason: ImStreamDegrade | null = null
  private lastText = ''
  private failures = 0
  private readonly throttle: ImStreamThrottle<string>
  private readonly now: () => number

  constructor(private readonly deps: LiveDeps) {
    this.now = deps.now ?? Date.now
    this.throttle = new ImStreamThrottle<string>(
      async (text) => {
        await deps.write(text)
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
    return this.state === 'live' && this.now() < this.deps.deadline
  }

  get counts(): ImStreamThrottle<string>['counts'] {
    return this.throttle.counts
  }

  update(view: ImTurnView): void {
    if (this.state !== 'live') {
      return
    }
    if (this.now() >= this.deps.deadline) {
      this.degrade('expired')
      return
    }
    const text = this.deps.render(view)
    if (text !== this.lastText) {
      this.lastText = text
      this.throttle.offer(text)
    }
  }

  degrade(reason: ImStreamDegrade): void {
    if (this.state !== 'live') {
      return
    }
    this.state = 'degraded'
    this.reason = reason
    void this.throttle.close()
    this.deps.onDegraded(reason)
  }

  /** Stops live frames and waits out the one in flight, so the final write is the last. */
  async close(): Promise<void> {
    if (this.state === 'live') {
      this.state = 'closed'
    }
    await this.throttle.close()
  }

  private failed(error: unknown): void {
    const reason = this.deps.classify(error)
    this.failures++
    if (reason) {
      this.degrade(reason)
    } else if (this.failures >= FAILURES_BEFORE_DEGRADE) {
      this.degrade('failed')
    }
  }
}
