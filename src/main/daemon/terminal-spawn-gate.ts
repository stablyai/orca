import {
  applySpawnAdmission,
  createSpawnAdmissionState,
  decideSpawnAdmission,
  DEFAULT_SPAWN_ADMISSION_LIMITS,
  pruneUserResumeBuckets,
  releaseLiveAutomatic,
  resolveSpawnCharge,
  settleSpawnAdmission,
  TERMINAL_SPAWN_REFUSED_MESSAGE,
  type AutomaticWorkMode,
  type HostPressureLevel,
  type SpawnAdmissionDecision,
  type SpawnAdmissionLimits,
  type SpawnAdmissionState,
  type SpawnCharge,
  type SpawnRequestFacts
} from '../../shared/host-spawn-admission'
import { withOtherDaemonsAutomaticWork } from '../../shared/host-automatic-work-budget'
import { DEFAULT_MAX_HOST_TERMINALS, HostTerminalLedger } from './host-terminal-ledger'
import { TerminalSpawnDeferredError } from './terminal-spawn-deferred-error'
import type { LegacyRestoreDetails, LegacyRestoreRecords } from './legacy-restore-records'
import { admitRecordingLegacyRestore } from './legacy-restore-admission'
import { TerminalSpawnWaiters } from './terminal-spawn-waiters'
import { hostTerminalCapRefusal, TerminalSpawnHostShare } from './terminal-spawn-host-share'

export type TerminalSpawnAdmissionMode = 'observe' | 'enforce'

const RECENT_AUTOMATIC_WORK_MS = 10 * 60_000
// Poll because another daemon releasing a slot cannot wake local waiters.
const OTHER_DAEMON_POLL_MS = 500

export const TERMINAL_SPAWN_ADMISSION_ARG = '--spawn-admission'

// Observe bypasses pacing while retaining decisions for diagnostics.
export const TERMINAL_SPAWN_ADMISSION_ENV_VAR = 'ORCA_TERMINAL_SPAWN_ADMISSION'

export function resolveTerminalSpawnAdmissionMode(
  env: NodeJS.ProcessEnv = process.env
): TerminalSpawnAdmissionMode {
  return env[TERMINAL_SPAWN_ADMISSION_ENV_VAR]?.trim().toLowerCase() === 'observe'
    ? 'observe'
    : 'enforce'
}

export function readTerminalSpawnAdmissionArg(argv: readonly string[]): TerminalSpawnAdmissionMode {
  const index = argv.indexOf(TERMINAL_SPAWN_ADMISSION_ARG)
  return index !== -1 && argv[index + 1] === 'enforce' ? 'enforce' : 'observe'
}

export type TerminalSpawnLease = {
  readonly charge: SpawnCharge
  /** The fork published a session; only a live automatic one holds a live-cap slot. */
  commit(sessionId: string, isAlive: boolean): void
  /** The fork never published a session. */
  abandon(): void
}

export type TerminalSpawnGateSnapshot = {
  mode: TerminalSpawnAdmissionMode
  inFlight: Record<SpawnCharge, number>
  liveAutomatic: number
  /** Count live and starting terminals of every charge. */
  terminals: number
  waiting: number
  waited: number
  deferred: number
  refused: number
  hostCapRefused: number
}

type TerminalSpawnGateOptions = {
  log: (event: string, details: Record<string, unknown>) => void
  mode?: TerminalSpawnAdmissionMode
  limits?: SpawnAdmissionLimits
  now?: () => number
  pressure?: () => HostPressureLevel
  automaticWorkMode?: () => AutomaticWorkMode
  /** Runs synchronously before the first automatic fork is admitted. */
  armAutomaticWork?: () => void
  /** The execution host's terminal cap; defaults to capping this daemon alone. */
  hostTerminals?: HostTerminalLedger
  /** Retain refused restores for clients that already discarded their own resume records. */
  legacyRestores?: LegacyRestoreRecords
}

/** Observe skips pacing, never the host cap; only declared callers can defer into sleeping panes. */
export class TerminalSpawnGate {
  private readonly mode: TerminalSpawnAdmissionMode
  private readonly limits: SpawnAdmissionLimits
  private readonly now: () => number
  private readonly pressure: () => HostPressureLevel
  private readonly automaticWorkMode: () => AutomaticWorkMode
  private readonly state: SpawnAdmissionState
  private readonly liveAutomaticSessions = new Set<string>()
  private readonly host: TerminalSpawnHostShare
  private readonly waiters: TerminalSpawnWaiters
  private waited = 0
  private lastAutomaticAdmitAt: number | null = null
  private deferred = 0
  private refused = 0
  private hostCapRefused = 0

  constructor(private readonly options: TerminalSpawnGateOptions) {
    this.mode = options.mode ?? 'observe'
    this.limits = options.limits ?? DEFAULT_SPAWN_ADMISSION_LIMITS
    this.now = options.now ?? Date.now
    this.pressure = options.pressure ?? (() => 'unknown')
    this.automaticWorkMode = options.automaticWorkMode ?? (() => ({ kind: 'normal' }))
    this.state = createSpawnAdmissionState(this.limits, this.now())
    this.waiters = new TerminalSpawnWaiters(this.now)
    this.host = new TerminalSpawnHostShare(
      options.hostTerminals ??
        new HostTerminalLedger({
          dir: null,
          maxTerminals: DEFAULT_MAX_HOST_TERMINALS,
          log: options.log
        })
    )
  }

  /** Keep unpaced admission synchronous to preserve ordering against the host's shutdown fence. */
  admit(
    facts: SpawnRequestFacts,
    cancel?: { signal: AbortSignal; error: () => Error },
    restore?: LegacyRestoreDetails
  ): TerminalSpawnLease | Promise<TerminalSpawnLease> {
    return admitRecordingLegacyRestore(
      () => {
        const attempt = this.attempt(facts, cancel, false)
        return attempt.kind === 'lease'
          ? attempt.lease
          : this.admitAfterWait(facts, cancel, attempt)
      },
      this.options.legacyRestores,
      facts,
      restore
    )
  }

  private async admitAfterWait(
    facts: SpawnRequestFacts,
    cancel: { signal: AbortSignal; error: () => Error } | undefined,
    first: { kind: 'wait'; untilMs: number }
  ): Promise<TerminalSpawnLease> {
    let attempt: ReturnType<TerminalSpawnGate['attempt']> = first
    while (attempt.kind === 'wait') {
      await this.waiters.waitForChange(attempt.untilMs, cancel?.signal)
      attempt = this.attempt(facts, cancel, true)
    }
    return attempt.lease
  }

  private attempt(
    facts: SpawnRequestFacts,
    cancel: { signal: AbortSignal; error: () => Error } | undefined,
    alreadyWaited: boolean
  ): { kind: 'lease'; lease: TerminalSpawnLease } | { kind: 'wait'; untilMs: number } {
    if (cancel?.signal.aborted) {
      throw cancel.error()
    }
    const now = this.now()
    pruneUserResumeBuckets(this.state, this.limits, now)
    const others = this.host.readOthers(now)
    const charge = resolveSpawnCharge(this.state, facts, this.limits, now)
    const decision = decideSpawnAdmission({
      state: withOtherDaemonsAutomaticWork(
        this.state,
        others.automatic,
        this.host.admits,
        this.limits,
        now
      ),
      facts,
      charge,
      pressure: this.pressure(),
      mode: this.automaticWorkMode(),
      limits: this.limits,
      now
    })
    if (this.mode === 'observe' || decision.kind === 'admit') {
      // Reserve first so refused forks cannot be logged as admitted.
      if (!this.host.tryReserve(this.state)) {
        this.refuseAtHostCap(facts, charge)
      }
      this.record(decision, charge, facts, !alreadyWaited)
      return { kind: 'lease', lease: this.lease(facts, charge, now) }
    }
    // Refuse at the host cap before spending time in the pacing queue.
    if (
      decision.kind === 'wait' &&
      this.host.terminals(this.state) + 1 + others.terminals > this.host.maxTerminals
    ) {
      this.refuseAtHostCap(facts, charge)
    }
    this.record(decision, charge, facts, !alreadyWaited)
    if (decision.kind === 'defer') {
      throw new TerminalSpawnDeferredError(decision.reason)
    }
    if (decision.kind === 'refuse_retryable') {
      throw new Error(TERMINAL_SPAWN_REFUSED_MESSAGE)
    }
    const otherDaemonHoldsSlot = decision.retryAt === null && others.automatic.inFlight > 0
    return {
      kind: 'wait',
      untilMs: Math.min(
        decision.retryAt ?? (otherDaemonHoldsSlot ? now + OTHER_DAEMON_POLL_MS : Infinity),
        facts.deadlineAt
      )
    }
  }

  onPressureChanged(): void {
    this.waiters.wakeAll()
  }

  hasRecentAutomaticWork(now: number = this.now()): boolean {
    return (
      this.lastAutomaticAdmitAt !== null &&
      now - this.lastAutomaticAdmitAt < RECENT_AUTOMATIC_WORK_MS
    )
  }

  onSessionExit(sessionId: string): void {
    const wasLive = this.host.removeLive(sessionId)
    const wasLiveAutomatic = this.liveAutomaticSessions.delete(sessionId)
    if (wasLiveAutomatic) {
      releaseLiveAutomatic(this.state)
    }
    if (wasLive || wasLiveAutomatic) {
      this.host.publish(this.state)
      this.waiters.wakeAll()
    }
  }

  snapshot(): TerminalSpawnGateSnapshot {
    return {
      mode: this.mode,
      inFlight: { ...this.state.inFlight },
      liveAutomatic: this.state.liveAutomatic,
      terminals: this.host.terminals(this.state),
      waiting: this.waiters.size,
      waited: this.waited,
      deferred: this.deferred,
      refused: this.refused,
      hostCapRefused: this.hostCapRefused
    }
  }

  startHostTerminals(): void {
    this.host.start()
  }

  stopHostTerminals(): void {
    this.host.stop()
  }

  private refuseAtHostCap(facts: SpawnRequestFacts, charge: SpawnCharge): never {
    this.hostCapRefused += 1
    try {
      this.options.log('host-terminal-cap-reached', {
        charge,
        declaredIntent: facts.declaredIntent,
        terminals: this.host.terminals(this.state),
        maxTerminals: this.host.maxTerminals
      })
    } catch {
      // Diagnostics must never change the refusal.
    }
    throw hostTerminalCapRefusal(facts, charge)
  }

  private lease(facts: SpawnRequestFacts, charge: SpawnCharge, now: number): TerminalSpawnLease {
    if (charge === 'automatic') {
      this.options.armAutomaticWork?.()
      this.lastAutomaticAdmitAt = now
      this.host.recordAutomaticAdmit(now)
    }
    applySpawnAdmission(this.state, facts, charge, this.limits, now)
    if (charge === 'automatic') {
      this.host.publish(this.state)
    }
    let settled = false
    const settle = (sessionId: string | null, isAlive: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      const becameLive = charge === 'automatic' && isAlive && sessionId !== null
      settleSpawnAdmission(this.state, charge, becameLive)
      if (becameLive) {
        this.liveAutomaticSessions.add(sessionId)
      }
      if (isAlive && sessionId !== null) {
        this.host.addLive(sessionId)
      }
      this.host.publish(this.state)
      this.waiters.wakeAll()
    }
    return {
      charge,
      commit: (sessionId, isAlive) => settle(sessionId, isAlive),
      abandon: () => settle(null, false)
    }
  }

  private record(
    decision: SpawnAdmissionDecision,
    charge: SpawnCharge,
    facts: SpawnRequestFacts,
    firstDecision: boolean
  ): void {
    // Count each request once, even when its waiter wakes and re-decides.
    if ((decision.kind === 'admit' && charge === 'interactive') || !firstDecision) {
      return
    }
    if (decision.kind === 'wait') {
      this.waited += 1
    } else if (decision.kind === 'defer') {
      this.deferred += 1
    } else if (decision.kind === 'refuse_retryable') {
      this.refused += 1
    }
    try {
      this.options.log(this.mode === 'observe' ? 'spawn-admission-observed' : 'spawn-admission', {
        decision: decision.kind,
        ...(decision.kind === 'defer' ? { reason: decision.reason } : {}),
        charge,
        declaredIntent: facts.declaredIntent,
        inFlightAutomatic: this.state.inFlight.automatic,
        liveAutomatic: this.state.liveAutomatic
      })
    } catch {
      // Diagnostics must never turn an admitted fork into a failed create.
    }
  }
}
