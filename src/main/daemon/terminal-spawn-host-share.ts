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

/** This daemon's part of the host-wide terminal count and automatic-restore budget. */
export class TerminalSpawnHostShare {
  private readonly liveSessions = new Set<string>()
  private automaticAdmits: number[] = []

  constructor(private readonly ledger: HostTerminalLedger) {}

  get maxTerminals(): number {
    return this.ledger.maxTerminals
  }

  get admits(): readonly number[] {
    return this.automaticAdmits
  }

  /** Every other daemon's share; also lets this daemon's old admits age out. */
  readOthers(now: number): OtherDaemonsShare {
    this.automaticAdmits = recentAutomaticAdmits(this.automaticAdmits, now)
    return this.ledger.readOthers()
  }

  terminals(state: SpawnAdmissionState): number {
    const { interactive, user, automatic } = state.inFlight
    return this.liveSessions.size + interactive + user + automatic
  }

  tryReserve(state: SpawnAdmissionState): boolean {
    return this.ledger.tryReserve(this.share(state))
  }

  recordAutomaticAdmit(now: number): void {
    // Why a new array: the ledger compares against the share it last wrote to skip rewrites.
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

/** A caller that declared a restore keeps its pane sleeping with its handle; every other
 *  caller, old ones included, gets a plain message it already renders as an error. */
export function hostTerminalCapRefusal(facts: SpawnRequestFacts, charge: SpawnCharge): Error {
  return facts.declaredIntent !== null && charge !== 'interactive'
    ? new TerminalSpawnDeferredError('live_cap')
    : new Error(TERMINAL_HOST_CAP_HINT)
}
