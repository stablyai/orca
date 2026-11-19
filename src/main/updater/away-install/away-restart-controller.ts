import type { UpdateStatus } from '../../../shared/updater/update-status-types'

export const AWAY_IDLE_SECONDS = 600
const AWAY_POLL_MS = 60_000
const AUTO_RESTART_COUNTDOWN_MS = 10_000
const AUTO_RESTART_DUE_TTL_MS = 30_000
const COUNTDOWN_TICK_MS = 1_000
const MAX_COUNTDOWN_LATENESS_MS = 5_000

type AwayRestartDeps = {
  isEligible(): boolean
  readAway(): boolean | undefined
  readIdleSeconds(): number
  findInterruptingWork(): string | null
  now(): number
  schedule(run: () => void, delayMs: number): () => void
  publish(): void
  requestRestart(version: string): boolean
  record(event: string, data: Record<string, string | number>): void
}

type Phase =
  | { kind: 'waiting'; version: string }
  | { kind: 'countdown'; version: string; deadline: number; lastIdle: number }
  | { kind: 'due'; version: string; deadline: number }

export class AwayRestartController {
  private phase: Phase | null = null
  private cancelTimer: (() => void) | undefined
  private declinedVersion: string | null = null
  private needsPresence = false
  private lastBlockingReason: string | null = null
  private lastPublishedEligibility = false

  constructor(private readonly deps: AwayRestartDeps) {}

  follow(status: UpdateStatus): void {
    if (status.state !== 'downloaded' || status.installing) {
      this.disarm()
      return
    }
    this.lastPublishedEligibility = this.deps.isEligible()
    if (this.phase?.version === status.version) {
      return
    }
    this.disarm()
    this.phase = { kind: 'waiting', version: status.version }
    this.poll()
  }

  evaluateNow(): void {
    const phase = this.phase
    if (phase?.kind !== 'waiting') {
      return
    }
    const eligible = this.deps.isEligible()
    if (eligible !== this.lastPublishedEligibility) {
      this.lastPublishedEligibility = eligible
      this.deps.publish()
    }
    if (!eligible || this.isDeclined(phase.version)) {
      this.lastBlockingReason = null
      this.poll()
      return
    }
    const away = this.deps.readAway()
    if (away === false) {
      this.needsPresence = false
    }
    if (away !== true || this.needsPresence) {
      this.lastBlockingReason = null
      this.poll()
      return
    }
    const reason = this.deps.findInterruptingWork()
    if (reason !== null && reason !== this.lastBlockingReason) {
      this.deps.record('auto_restart_blocked', { reason })
    }
    this.lastBlockingReason = reason
    if (reason !== null) {
      this.poll()
      return
    }
    const countdown = {
      kind: 'countdown',
      version: phase.version,
      deadline: this.deps.now() + AUTO_RESTART_COUNTDOWN_MS,
      lastIdle: this.deps.readIdleSeconds()
    } as const
    this.phase = countdown
    this.deps.publish()
    if (this.phase === countdown) {
      this.scheduleTick()
    }
  }

  decline(): boolean {
    if (!this.phase) {
      return false
    }
    this.declinedVersion = this.phase.version
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.phase = { kind: 'waiting', version: this.declinedVersion }
    this.lastBlockingReason = null
    this.deps.publish()
    return true
  }

  interrupt(reason: string): void {
    if (this.phase?.kind === 'countdown' || this.phase?.kind === 'due') {
      this.cancelUntilPresent(reason)
    }
  }

  confirmUnattendedRestart(): boolean {
    if (this.phase?.kind !== 'due') {
      return false
    }
    if (!this.deps.isEligible()) {
      this.cancel('ineligible')
      return false
    }
    if (this.deps.readAway() !== true) {
      this.cancelUntilPresent('presence')
      return false
    }
    if (this.deps.findInterruptingWork() !== null) {
      this.cancel('blocked')
      return false
    }
    return true
  }

  countdownDeadline(version: string): number | null {
    const phase = this.phase
    return phase?.version === version && phase.kind !== 'waiting' ? phase.deadline : null
  }

  isDeclined(version: string): boolean {
    return this.declinedVersion === version
  }

  private disarm(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.phase = null
    this.needsPresence = false
    this.lastBlockingReason = null
  }

  private poll(): void {
    this.schedule(() => this.evaluateNow(), AWAY_POLL_MS)
  }

  private scheduleTick(): void {
    this.schedule(() => this.tick(), COUNTDOWN_TICK_MS)
  }

  private schedule(run: () => void, delayMs: number): void {
    this.cancelTimer?.()
    this.cancelTimer = this.deps.schedule(() => {
      this.cancelTimer = undefined
      run()
    }, delayMs)
  }

  private tick(): void {
    const phase = this.phase
    if (phase?.kind !== 'countdown') {
      return
    }
    if (!this.deps.isEligible()) {
      this.cancel('ineligible')
      return
    }
    if (this.deps.readAway() !== true) {
      this.cancelUntilPresent('presence')
      return
    }
    const now = this.deps.now()
    if (now - phase.deadline > MAX_COUNTDOWN_LATENESS_MS) {
      this.cancel('late')
      return
    }
    const idle = this.deps.readIdleSeconds()
    if (!(idle >= phase.lastIdle)) {
      this.cancelUntilPresent('input')
      return
    }
    phase.lastIdle = idle
    if (now < phase.deadline) {
      this.scheduleTick()
      return
    }
    if (this.deps.findInterruptingWork() !== null) {
      this.cancel('blocked')
      return
    }
    if (!this.deps.requestRestart(phase.version)) {
      this.cancelUntilPresent('no-window')
      return
    }
    this.phase = { kind: 'due', version: phase.version, deadline: phase.deadline }
    this.schedule(() => this.cancel('expired'), AUTO_RESTART_DUE_TTL_MS)
    this.deps.record('auto_restart_requested', { version: phase.version })
  }

  private cancelUntilPresent(reason: string): void {
    this.needsPresence = true
    this.cancel(reason)
  }

  private cancel(reason: string): void {
    if (!this.phase) {
      return
    }
    const waiting = { kind: 'waiting', version: this.phase.version } as const
    this.phase = waiting
    this.lastBlockingReason = null
    this.deps.record('auto_restart_cancelled', { reason })
    this.deps.publish()
    if (this.phase === waiting) {
      this.poll()
    }
  }
}
