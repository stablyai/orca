import type { SpawnAdmissionState } from '../../../shared/terminal/pty/admission/host-spawn-admission'
import type {
  SpawnCharge,
  SpawnRequestFacts
} from '../../../shared/terminal/pty/admission/spawn-admission-contract'
import { recentAutomaticAdmits } from '../../../shared/terminal/pty/admission/host-automatic-work-budget'
import { TerminalHostCapError } from '../../../shared/terminal/pty/lifecycle/terminal-host-cap-refusal'
import type { HostTerminalLedger, OtherDaemonsShare } from './host-terminal-ledger'
import type { HostTerminalShare } from './host-terminal-ledger-entry'
import type { HostTerminalUsage } from '../../../shared/terminal/runtime-policy/terminal-limit-policy'
import { TerminalSpawnDeferredError } from './terminal-spawn-deferred-error'

export class TerminalSpawnHostShare {
  private readonly liveSessions = new Set<string>()
  private automaticAdmits: number[] = []
  /** Other daemons' terminals as the latest ledger read counted them. */
  private otherTerminals = 0

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
    const others = this.ledger.readOthers()
    this.otherTerminals = others.terminals
    return others
  }

  usage(state: SpawnAdmissionState, maxTerminals: number): HostTerminalUsage {
    return { terminalsInUse: this.terminals(state) + this.otherTerminals, maxTerminals }
  }

  terminals(state: SpawnAdmissionState): number {
    const { interactive, user, automatic } = state.inFlight
    return this.liveSessions.size + interactive + user + automatic
  }

  tryReserve(state: SpawnAdmissionState, maximum = this.maxTerminals): boolean {
    return this.ledger.tryReserve(this.share(state), maximum)
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

/** Declared restores retain sleeping panes; other callers get the cap and its counts. */
export function hostTerminalCapRefusal(
  facts: SpawnRequestFacts,
  charge: SpawnCharge,
  cap: { inUse: number; limit: number }
): Error {
  return facts.declaredIntent !== null && charge !== 'interactive'
    ? new TerminalSpawnDeferredError('live_cap')
    : new TerminalHostCapError(cap.inUse, cap.limit)
}
