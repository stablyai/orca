import type { OpenedControl } from './relay-control-failover'

// Client two-path connect race (docs: client-two-path, option C). Inert unless the director answered
// alternateCellUrls: without one, a fresh connect is today's single dial with no timer. Only fresh
// connects race; resumes (rotation, same-cell recovery, failover) keep their single dial.

// The primary has this long to deliver the edge's first frame before the alternate is dialled too.
export const CONTROL_RACE_STAGGER_MS = 1_500

/** claim() runs when a leg's valid host-challenge arrives; abort closes a leg before it answers. */
export type ControlRaceLeg = { claim: () => boolean; signal: AbortSignal }

export type ControlRaceHost = {
  primaryUrl: string
  alternateUrl: string | undefined
  isClosed: () => boolean
  open: (dialUrl: string, leg?: ControlRaceLeg) => Promise<OpenedControl>
}

export type RacedControl = OpenedControl & { dialUrl: string }

export async function openRacedControl(host: ControlRaceHost): Promise<RacedControl> {
  if (!host.alternateUrl || host.alternateUrl === host.primaryUrl) {
    return { ...(await host.open(host.primaryUrl)), dialUrl: host.primaryUrl }
  }
  return new ControlRace(host, host.alternateUrl).run()
}

// The winner is the first leg to deliver a valid host-challenge, never a TCP/TLS connect alone (a
// path can complete TCP and then lose TLS). Only the winner answers its challenge; the loser is
// closed before it acks anything, so its hello changes no edge state.
class ControlRace {
  private winner: string | null = null
  private readonly legs = new Map<string, AbortController>()
  private failures = 0
  private primaryError: unknown = null
  private staggerTimer: ReturnType<typeof setTimeout> | null = null
  private readonly startedAt = Date.now()
  private settle: { resolve: (raced: RacedControl) => void; reject: (error: unknown) => void } = {
    resolve: () => {},
    reject: () => {}
  }

  constructor(
    private readonly host: ControlRaceHost,
    private readonly alternateUrl: string
  ) {}

  run(): Promise<RacedControl> {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject }
      this.dial(this.host.primaryUrl)
      this.staggerTimer = setTimeout(
        () => this.dialAlternate('primary-slow'),
        CONTROL_RACE_STAGGER_MS
      )
      this.staggerTimer.unref?.()
    })
  }

  private dialAlternate(reason: 'primary-slow' | 'primary-failed'): void {
    this.clearStagger()
    if (this.winner !== null || this.legs.has(this.alternateUrl) || this.host.isClosed()) {
      return
    }
    console.warn(
      `[relay] control race started reason=${reason} afterMs=${Date.now() - this.startedAt} primary=${this.host.primaryUrl} alternate=${this.alternateUrl}`
    )
    this.dial(this.alternateUrl)
  }

  private dial(dialUrl: string): void {
    const abort = new AbortController()
    this.legs.set(dialUrl, abort)
    this.host.open(dialUrl, { claim: () => this.claim(dialUrl), signal: abort.signal }).then(
      (opened) => this.connected(dialUrl, opened),
      (error: unknown) => this.failed(dialUrl, error)
    )
  }

  private claim(dialUrl: string): boolean {
    if (this.winner !== null) {
      return this.winner === dialUrl
    }
    this.winner = dialUrl
    this.clearStagger()
    if (this.legs.size < 2) {
      return true
    }
    console.warn(
      `[relay] control race won path=${this.pathOf(dialUrl)} url=${dialUrl} elapsedMs=${Date.now() - this.startedAt}`
    )
    for (const [url, abort] of this.legs) {
      if (url !== dialUrl) {
        // Synchronous: the loser is closed before this winner's ack is even sent.
        abort.abort()
        console.warn(`[relay] control race loser closed path=${this.pathOf(url)} url=${url}`)
      }
    }
    return true
  }

  private connected(dialUrl: string, opened: OpenedControl): void {
    if (this.winner !== dialUrl) {
      opened.control.closeNow()
      return
    }
    this.settle.resolve({ ...opened, dialUrl })
  }

  private failed(dialUrl: string, error: unknown): void {
    if (this.winner === dialUrl) {
      // The winner failed after its challenge (proof refused, closed): no path is left to fall to.
      this.settle.reject(error)
      return
    }
    if (this.winner !== null) {
      return
    }
    this.failures += 1
    if (dialUrl === this.host.primaryUrl) {
      this.primaryError = error
      if (!this.legs.has(this.alternateUrl) && !this.host.isClosed()) {
        this.dialAlternate('primary-failed')
        return
      }
    }
    if (this.failures < this.legs.size) {
      return
    }
    this.clearStagger()
    console.warn(
      `[relay] control race failed on every path elapsedMs=${Date.now() - this.startedAt}`
    )
    // The primary's error keeps today's single-path classification for director recovery.
    this.settle.reject(this.primaryError ?? error)
  }

  private pathOf(dialUrl: string): 'primary' | 'alternate' {
    return dialUrl === this.host.primaryUrl ? 'primary' : 'alternate'
  }

  private clearStagger(): void {
    if (this.staggerTimer) {
      clearTimeout(this.staggerTimer)
      this.staggerTimer = null
    }
  }
}
