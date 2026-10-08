/**
 * Decides when a managed orcad has been unused long enough to stop.
 *
 * Every probe must answer `idle` on the same check, continuously for the whole quiet period.
 * A probe that throws or cannot answer counts as busy: silence is never evidence of idleness.
 */

export type OrcadIdleVerdict = 'idle' | 'busy' | 'unverifiable'

export type OrcadIdleProbe = {
  name: string
  read: () => OrcadIdleVerdict | Promise<OrcadIdleVerdict>
}

export type OrcadIdleExitEvidence = { quietSince: number; stoppedAt: number; timeoutMs: number }

export type OrcadIdleExitMonitorOptions = {
  timeoutMs: number
  probes: readonly OrcadIdleProbe[]
  /** Any client request restarts the quiet period, even one that came and went between checks. */
  lastClientActivityAt: () => number
  onIdle: (evidence: OrcadIdleExitEvidence) => void
  now?: () => number
  pollMs?: number
  log?: (line: string) => void
}

export function resolveOrcadIdlePollMs(timeoutMs: number): number {
  return Math.min(60_000, Math.max(250, Math.floor(timeoutMs / 5)))
}

export class OrcadIdleExitMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private quietSince: number | null = null
  private blocker: string | null = null
  private stopped = false
  private readonly now: () => number
  private readonly pollMs: number
  private readonly log: (line: string) => void

  constructor(private readonly options: OrcadIdleExitMonitorOptions) {
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? resolveOrcadIdlePollMs(options.timeoutMs)
    this.log = options.log ?? ((line) => console.error(line))
  }

  start(): void {
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** One check; resolves true once the quiet period elapsed and `onIdle` fired. */
  async check(): Promise<boolean> {
    const blocker = await this.findBlocker()
    if (this.stopped) {
      return false
    }
    const now = this.now()
    if (blocker) {
      if (this.quietSince !== null || this.blocker !== blocker) {
        this.log(`[orcad] idle exit waiting: ${blocker}`)
      }
      this.quietSince = null
      this.blocker = blocker
      return false
    }
    if (this.quietSince === null) {
      this.quietSince = now
      this.blocker = null
      this.log(`[orcad] idle; stopping after ${this.options.timeoutMs}ms unless a client returns`)
    }
    const quietSince = Math.max(this.quietSince, this.options.lastClientActivityAt())
    if (now - quietSince < this.options.timeoutMs) {
      return false
    }
    this.stop()
    this.options.onIdle({ quietSince, stoppedAt: now, timeoutMs: this.options.timeoutMs })
    return true
  }

  private async findBlocker(): Promise<string | null> {
    for (const probe of this.options.probes) {
      let verdict: OrcadIdleVerdict
      try {
        verdict = await probe.read()
      } catch {
        verdict = 'unverifiable'
      }
      if (verdict !== 'idle') {
        return `${probe.name} ${verdict}`
      }
    }
    return null
  }

  private schedule(): void {
    if (this.stopped) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check()
        .catch((error: unknown) => this.log(`[orcad] idle check failed: ${String(error)}`))
        .finally(() => this.schedule())
    }, this.pollMs)
    // Never the reason the process stays alive.
    this.timer.unref?.()
  }
}
