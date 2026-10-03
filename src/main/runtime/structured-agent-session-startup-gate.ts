// Holds every structured chat command until host startup has settled the chats a gone process left
// with work. Every open settles its own chat too, so what the hold adds is order: each crashed turn
// gets its verdict from the death evidence startup records first, never "Couldn't confirm" from an
// open that ran before it. Commands wait at their entry, before any chat's lock (the settle takes
// those locks); none is refused. It always opens: when the settle ends, however it ends, or at a
// ceiling, so a startup fault never strands a command.

import {
  createStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'

// Under the shortest client timeout on a held call, with margin: the AI vault's chat restore gives
// its reveal 5 s (activate-ai-vault-structured-session.ts); remote desktop and phone give 15 s.
// Counted from launch (`hold`). A held command lets go before its caller gives up, and an open
// settles its own chat, so letting go early is safe. Past it, the order is what is lost: a crashed
// turn may get its verdict from an open.
const STARTUP_GATE_CEILING_MS = 4_000

/** How the startup step ended. */
export type StartupStepOutcome =
  | 'settle ended'
  | 'settle failed'
  | 'step failed'
  | 'no chats on disk'
  | 'no host'

type StartupGateOpener = StartupStepOutcome | 'ceiling'

export class StructuredAgentSessionStartupGate {
  private pending: Promise<void> | null = null
  private release: (() => void) | null = null
  private ceiling: ReturnType<typeof setTimeout> | null = null
  private held = false
  // One timing line per launch, for the startup measurements. The step's times are recorded
  // whenever they happen, whoever opened the gate; the line is written once the gate is open and
  // the step is over.
  private heldAt: number | null = null
  private step: {
    startedAt: number
    ended: { at: number; outcome: StartupStepOutcome } | null
  } | null = null
  private opened: { at: number; by: StartupGateOpener } | null = null

  constructor(
    private readonly ceilingMs = STARTUP_GATE_CEILING_MS,
    private readonly now: () => number = Date.now,
    private readonly logger: StructuredAgentSessionLogger = createStructuredAgentSessionLogger()
  ) {}

  /** Closes the gate until it is opened, once per launch, before any request is served. */
  hold(): void {
    // One-shot: re-closing after it opened could hold /clear's replacement attach under a chat lock.
    if (this.held) {
      return
    }
    this.held = true
    this.heldAt = this.now()
    this.pending = new Promise((resolve) => {
      this.release = resolve
    })
    this.ceiling = setTimeout(() => {
      this.logger.warn('startup settle still running; chat commands go ahead', {
        scope: 'startup-gate-ceiling'
      })
      this.open('ceiling')
    }, this.ceilingMs)
    this.ceiling.unref?.()
  }

  /** The startup step began; only timed. */
  stepStarted(): void {
    this.step ??= { startedAt: this.now(), ended: null }
  }

  /** The startup step is over: timed, and the gate opens now unless the ceiling opened it. */
  stepEnded(outcome: StartupStepOutcome): void {
    const at = this.now()
    this.step ??= { startedAt: at, ended: null }
    this.step.ended ??= { at, outcome }
    this.open(outcome)
  }

  /** The step ends when the settle does, whether it settled or failed. */
  openWhen(settled: Promise<unknown>): void {
    void settled.then(
      () => this.stepEnded('settle ended'),
      (error: unknown) => {
        this.logger.warn('startup settle failed', { scope: 'startup-settle', error })
        this.stepEnded('settle failed')
      }
    )
  }

  /** What a chat command waits for, or null when the gate is open. */
  ready = (): Promise<void> | null => this.pending

  private open(by: StartupGateOpener): void {
    if (this.ceiling) {
      clearTimeout(this.ceiling)
      this.ceiling = null
    }
    if (this.pending) {
      this.opened = { at: this.now(), by }
    }
    this.release?.()
    this.release = null
    this.pending = null
    this.report()
  }

  private report(): void {
    const { heldAt, step, opened } = this
    if (heldAt === null || !opened || !step?.ended) {
      return
    }
    console.info(
      `[structured-agent-session] startup gate: held at launch; step started +${step.startedAt - heldAt} ms, ` +
        `ended +${step.ended.at - heldAt} ms (${step.ended.outcome}); opened +${opened.at - heldAt} ms by ${opened.by}`
    )
    this.heldAt = null
  }
}
