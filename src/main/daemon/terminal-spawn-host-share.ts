import type { TerminalSpawnAdmissionMode } from './terminal-spawn-admission-mode'
import type { SpawnAdmissionDecision } from '../../shared/host-spawn-admission'
import type {
  SpawnAdmissionState,
  SpawnCharge,
  SpawnRequestFacts
} from '../../shared/host-spawn-admission'
import { recentAutomaticAdmits } from '../../shared/host-automatic-work-budget'
import { TERMINAL_HOST_CAP_HINT } from '../../shared/terminal-spawn-error-copy'
import type { HostTerminalLedger, OtherDaemonsShare } from './host-terminal-ledger'
import type { HostTerminalShare } from './host-terminal-ledger-entry'
import { TerminalSpawnDeferredError } from './terminal-spawn-deferred-error'

export class TerminalSpawnHostShare {
  private readonly liveSessions = new Set<string>()
  private automaticAdmits: number[] = []
  private pendingLaunches = 0

  constructor(private readonly ledger: HostTerminalLedger) {}

  get maxTerminals(): number {
    return this.ledger.maxTerminals
  }

  get admits(): readonly number[] {
    return this.automaticAdmits
  }

  /** Also expire this daemon's old admission timestamps. */
  readOthers(now: number): OtherDaemonsShare {
    this.automaticAdmits = recentAutomaticAdmits(this.automaticAdmits, now)
    return this.ledger.readOthers()
  }

  terminals(state: SpawnAdmissionState): number {
    const { interactive, user, automatic } = state.inFlight
    return this.liveSessions.size + this.pendingLaunches + interactive + user + automatic
  }

  tryReserve(state: SpawnAdmissionState, maximum = this.maxTerminals): boolean {
    return this.ledger.tryReserve(this.share(state), maximum)
  }

  reservePending(state: SpawnAdmissionState, maximum: number): (() => void) | null {
    if (!this.tryReserve(state, maximum)) {
      return null
    }
    this.pendingLaunches++
    this.publish(state)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.pendingLaunches--
      this.publish(state)
    }
  }

  recordAutomaticAdmit(now: number): void {
    // Keep published snapshots immutable so the ledger can detect changes.
    this.automaticAdmits = [...this.automaticAdmits, now]
  }

  addLive(sessionId: string): void {
    this.liveSessions.add(sessionId)
  }

  removeLive(sessionId: string): boolean {
    return this.liveSessions.delete(sessionId)
  }

  publish(state: SpawnAdmissionState): void {
    try {
      this.ledger.publish(this.share(state))
    } catch {
      // The shared count is advisory for other daemons; this one's own cap still holds.
    }
  }

  start(): void {
    this.ledger.start()
  }

  stop(): void {
    this.ledger.close()
  }

  private share(state: SpawnAdmissionState): HostTerminalShare {
    return {
      terminals: this.terminals(state),
      automaticInFlight: state.inFlight.automatic,
      automaticLive: state.liveAutomatic,
      automaticAdmits: this.automaticAdmits
    }
  }
}

/** Declared restores retain sleeping panes; other callers need the legacy error message. */
export function hostTerminalCapRefusal(facts: SpawnRequestFacts, charge: SpawnCharge): Error {
  return facts.declaredIntent !== null && charge !== 'interactive'
    ? new TerminalSpawnDeferredError('live_cap')
    : new Error(TERMINAL_HOST_CAP_HINT)
}

export function logSpawnAdmission(
  log: (event: string, details: Record<string, unknown>) => void,
  mode: TerminalSpawnAdmissionMode,
  decision: SpawnAdmissionDecision,
  charge: SpawnCharge,
  facts: SpawnRequestFacts,
  state: SpawnAdmissionState
): void {
  try {
    log(mode === 'observe' ? 'spawn-admission-observed' : 'spawn-admission', {
      decision: decision.kind,
      ...(decision.kind === 'defer' ? { reason: decision.reason } : {}),
      charge,
      declaredIntent: facts.declaredIntent,
      inFlightAutomatic: state.inFlight.automatic,
      liveAutomatic: state.liveAutomatic
    })
  } catch {
    // Diagnostics must never turn an admitted fork into a failed create.
  }
}

export function logHostTerminalCap(
  log: (event: string, details: Record<string, unknown>) => void,
  facts: SpawnRequestFacts,
  charge: SpawnCharge,
  terminals: number,
  maximum: number
): void {
  try {
    log('host-terminal-cap-reached', {
      charge,
      declaredIntent: facts.declaredIntent,
      terminals,
      maxTerminals: maximum
    })
  } catch {
    // Diagnostics must never change the refusal.
  }
}
