import type { RelayControlClient } from '../control-channel/relay-control-client'
import type { RelayHostHelloAckMessage } from '../control-channel/relay-control-protocol'

// Client two-path failover (docs: client-two-path, option A). Inert unless the director answered
// alternateCellUrls: only then does a primary-path control arm the stall detector that calls start().

// A path outage (an anycast event) stalls every host on it at once; 0-3s spreads their resumes.
const FAILOVER_START_JITTER_MS = 3_000

export type ControlResume = {
  relayJwt: string
  assignmentEpoch: number
  previousGeneration: number
  controlResumeSecret: string
}

export type OpenedControl = { control: RelayControlClient; ack: RelayHostHelloAckMessage }

export type RelayControlFailoverHost = {
  primaryUrl: () => string
  alternates: () => readonly string[]
  isClosed: () => boolean
  /** The resume to present, or null when `stalled` is not the only control (a rebind is in flight). */
  resumeFor: (stalled: RelayControlClient) => ControlResume | null
  open: (resume: ControlResume, dialUrl: string) => Promise<OpenedControl>
  /** Seats the resumed control (data dials follow dialUrl) and retires the stalled one. */
  promote: (opened: OpenedControl, dialUrl: string, stalled: RelayControlClient) => void
  /** Today's dead-control path: director recovery through the origin's close. */
  reportClose: (code: number) => void
  random?: () => number
}

export class RelayControlFailover {
  private running: Promise<void> | null = null
  // Set for exactly the failover's lifetime, so a close it triggers itself is reported normally.
  private inFlight = false
  // The stalled control closed while its failover was in flight: reported only if the failover fails.
  private closedDuringFailover: number | null = null
  private count = 0

  constructor(private readonly host: RelayControlFailoverHost) {}

  /** Settles once no failover is in flight; a rebind waits on it so two resumes never race. */
  get settled(): Promise<void> | null {
    return this.running
  }

  /** The active control closed: true when the failover owns that outcome for now. */
  deferClose(code: number): boolean {
    if (this.inFlight) {
      this.closedDuringFailover = code
    }
    return this.inFlight
  }

  start(stalled: RelayControlClient): void {
    const alternates = [...this.host.alternates()]
    const resume = this.running || this.host.isClosed() ? null : this.host.resumeFor(stalled)
    if (!resume || alternates.length === 0) {
      return
    }
    this.inFlight = true
    this.running = this.run(stalled, alternates, resume).finally(() => {
      this.running = null
    })
  }

  // Make-before-break: the stalled control stays open until the alternate's hello-ack proves the
  // resume. Only a resume is ever attempted here (no director ask, no epoch bump): a challenge that
  // declines it is never acked, so this path cannot mint a generation or 4408 the phones.
  private async run(
    stalled: RelayControlClient,
    alternates: string[],
    resume: ControlResume
  ): Promise<void> {
    const startedAt = Date.now()
    let resumedOn: string | null = null
    let closedCode: number | null = null
    try {
      resumedOn = await this.resumeOnFirstAlternate(stalled, alternates, resume)
    } finally {
      this.inFlight = false
      closedCode = this.closedDuringFailover
      this.closedDuringFailover = null
    }
    const elapsedMs = Date.now() - startedAt
    if (resumedOn) {
      this.count += 1
      console.warn(
        `[relay] control failover succeeded to=${resumedOn} elapsedMs=${elapsedMs} failovers=${this.count}`
      )
      return
    }
    if (this.host.isClosed()) {
      return
    }
    // Every alternate refused or timed out: recover exactly as a dead control does today.
    console.warn(
      `[relay] control failover fell back to director recovery from=${this.host.primaryUrl()} elapsedMs=${elapsedMs}`
    )
    if (closedCode !== null) {
      this.host.reportClose(closedCode)
    } else {
      // Its close (1006) reaches the origin as any dead control's does.
      stalled.closeNow()
    }
  }

  private async resumeOnFirstAlternate(
    stalled: RelayControlClient,
    alternates: string[],
    resume: ControlResume
  ): Promise<string | null> {
    const delayMs = Math.floor((this.host.random ?? Math.random)() * FAILOVER_START_JITTER_MS)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs).unref?.()
    })
    for (const dialUrl of alternates) {
      if (this.host.isClosed()) {
        return null
      }
      console.warn(`[relay] control failover attempt from=${this.host.primaryUrl()} to=${dialUrl}`)
      try {
        const opened = await this.host.open(resume, dialUrl)
        if (this.host.isClosed()) {
          opened.control.closeNow()
          return null
        }
        this.host.promote(opened, dialUrl, stalled)
        return dialUrl
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.warn(`[relay] control failover attempt failed to=${dialUrl} error=${reason}`)
      }
    }
    return null
  }
}
