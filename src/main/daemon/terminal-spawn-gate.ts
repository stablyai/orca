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
// Why poll: another daemon freeing a slot cannot wake this one's waiters.
const OTHER_DAEMON_POLL_MS = 500

export const TERMINAL_SPAWN_ADMISSION_ARG = '--spawn-admission'

// Rollback switch: `observe` makes newly launched daemons count decisions without pacing.
export const TERMINAL_SPAWN_ADMISSION_ENV_VAR = 'ORCA_TERMINAL_SPAWN_ADMISSION'

/** The mode a launcher passes its daemon: enforce, unless the env var asks for `observe`. */
export function resolveTerminalSpawnAdmissionMode(
  env: NodeJS.ProcessEnv = process.env
): TerminalSpawnAdmissionMode {
  return env[TERMINAL_SPAWN_ADMISSION_ENV_VAR]?.trim().toLowerCase() === 'observe'
    ? 'observe'
    : 'enforce'
}

/** Reads the launcher's `--spawn-admission <mode>`; anything else observes. */
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
  /** Live plus starting terminals of every charge; what the host cap counts for this daemon. */
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
  /** The host's copy of old-client restores it refused (owner decision Q9). */
  legacyRestores?: LegacyRestoreRecords
}

/**
 * The daemon's single fork gate. In `observe` every request is admitted at once and
 * the policy's verdict is only counted. In `enforce` automatic restores wait for a
 * slot inside the caller's deadline; a caller that declared an intent may instead be
 * told to keep its pane sleeping, and an undeclared caller is only ever paced.
 */
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

  /** Returns synchronously unless the request has to wait, so an unpaced fork keeps
   *  today's timing against the host's shutdown fence. */
  admit(
    facts: SpawnRequestFacts,
    cancel?: { signal: AbortSignal; error: () => Error },
    /** What the request would resume; recorded if an old client's restore is refused. */
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
      // Why: automatic restores share one budget with every other daemon on this host (Q1).
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
      // Why reserve before recording: a refused fork must not be logged as admitted.
      if (!this.host.tryReserve(this.state)) {
        this.refuseAtHostCap(facts, charge)
      }
      this.record(decision, charge, facts, !alreadyWaited)
      return { kind: 'lease', lease: this.lease(facts, charge, now) }
    }
    // Why: a request that would only wait to be refused at the cap is told at once.
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

  /** A pressure change can let a waiter through, or make it give up. */
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

  /** Starts keeping this daemon's entry in the host's shared count fresh. */
  startHostTerminals(): void {
    this.host.start()
  }

  /** Removes this daemon from the host's shared count; its sessions are gone. */
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
    // Why first only: a woken waiter re-decides, and counting each pass would inflate `waited`.
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
