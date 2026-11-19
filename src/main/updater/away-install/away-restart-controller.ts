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

type RestartPhase = {
  kind: 'countdown' | 'due'
  version: string
  deadline: number
  lastIdle: number
  lastSampleAt: number
}

type Phase = { kind: 'waiting'; version: string } | RestartPhase

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
    const lastIdle = this.deps.readIdleSeconds()
    const lastSampleAt = this.deps.now()
    const countdown: RestartPhase = {
      kind: 'countdown',
      version: phase.version,
      deadline: lastSampleAt + AUTO_RESTART_COUNTDOWN_MS,
      lastIdle,
      lastSampleAt
    }
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

  userReturned(): void {
    this.needsPresence = false
    if (this.phase?.kind === 'countdown' || this.phase?.kind === 'due') {
      this.cancel('presence')
    }
  }

  confirmUnattendedRestart(): boolean {
    const phase = this.phase
    if (phase?.kind !== 'due') {
      return false
    }
    if (!this.deps.isEligible()) {
      this.cancel('ineligible')
      return false
    }
    if (!this.confirmAway()) {
      return false
    }
    if (this.sawInput(phase)) {
      this.cancelUntilPresent('input')
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
    if (!this.confirmAway()) {
      return
    }
    const now = this.deps.now()
    if (now - phase.deadline > MAX_COUNTDOWN_LATENESS_MS) {
      this.cancel('late')
      return
    }
    if (this.sawInput(phase)) {
      this.cancelUntilPresent('input')
      return
    }
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
    this.phase = { ...phase, kind: 'due' }
    this.schedule(() => this.cancel('expired'), AUTO_RESTART_DUE_TTL_MS)
    this.deps.record('auto_restart_requested', { version: phase.version })
  }

  private confirmAway(): boolean {
    const away = this.deps.readAway()
    if (away === false) {
      this.userReturned()
    } else if (away === undefined) {
      this.cancelUntilPresent('presence')
    }
    return away === true
  }

  private sawInput(phase: RestartPhase): boolean {
    const idle = this.deps.readIdleSeconds()
    const now = this.deps.now()
    // Without input, the idle clock advances by at least the whole seconds elapsed between samples.
    const elapsed = Math.floor((now - phase.lastSampleAt) / 1000)
    if (!(idle >= phase.lastIdle + elapsed)) {
      return true
    }
    phase.lastIdle = idle
    phase.lastSampleAt = now
    return false
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
