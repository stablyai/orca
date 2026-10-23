import type {
  AutomaticWorkMode,
  AutomaticWorkResumeResult,
  AutomaticWorkStatus,
  HostPressureLevel
} from '../../shared/host-spawn-admission'
import type { ProcessGrowthTrip } from '../../shared/process-growth-breaker'
import { AutomaticWorkRunMarker } from './automatic-work-run-marker-store'
import type { AutomaticWorkRequestType } from './daemon-automatic-work-protocol'
import { DaemonProcessGrowthMonitor } from './daemon-process-growth-monitor'
import { HostTerminalLedger, resolveMaxHostTerminals } from './host-terminal-ledger'
import { LegacyRestoreRecords, legacyRestoreRecordsPathFor } from './legacy-restore-records'
import { TerminalSpawnGate, type TerminalSpawnAdmissionMode } from './terminal-spawn-gate'

type DaemonAutomaticWorkGuardOptions = {
  markerPath: string | undefined
  /** Where every daemon on this host shares its terminal count; undefined caps this one alone. */
  hostTerminalLedgerDir?: string | undefined
  mode: TerminalSpawnAdmissionMode
  log: { log: (event: string, details: Record<string, unknown>) => void }
  listSessions: () => readonly { sessionId: string; pid: number | null }[]
  ownsEndpoint: () => boolean
  /** Test seam for the growth monitor's process table. */
  monitor?: DaemonProcessGrowthMonitor
}

/**
 * Everything that decides whether the daemon may start automatic work: the fork gate,
 * the same-boot crash marker, and the process-growth breaker that pauses it.
 */
export class DaemonAutomaticWorkGuard {
  readonly gate: TerminalSpawnGate
  private readonly marker: AutomaticWorkRunMarker
  private readonly legacyRestores: LegacyRestoreRecords
  private readonly monitor: DaemonProcessGrowthMonitor
  private pressurePausedSince: number | null = null

  constructor(private readonly options: DaemonAutomaticWorkGuardOptions) {
    this.marker = new AutomaticWorkRunMarker(options.markerPath, options.log, options.ownsEndpoint)
    this.legacyRestores = new LegacyRestoreRecords(
      options.markerPath ? legacyRestoreRecordsPathFor(options.markerPath) : undefined,
      options.log
    )
    this.monitor =
      options.monitor ??
      new DaemonProcessGrowthMonitor({
        listSessions: options.listSessions,
        recentAutomaticWork: () => this.gate.hasRecentAutomaticWork(),
        sampleWhenIdle: options.mode === 'enforce',
        onLevelChanged: (level) => this.onPressureChanged(level),
        onTrip: (trips) => this.onTrip(trips)
      })
    this.gate = new TerminalSpawnGate({
      log: (event, details) => options.log.log(event, details),
      mode: options.mode,
      pressure: () => this.monitor.level,
      automaticWorkMode: () => this.automaticWorkMode(),
      armAutomaticWork: () => this.marker.arm(),
      legacyRestores: this.legacyRestores,
      hostTerminals: new HostTerminalLedger({
        dir: options.hostTerminalLedgerDir ?? null,
        maxTerminals: resolveMaxHostTerminals(),
        log: (event, details) => options.log.log(event, details)
      })
    })
  }

  /** Called once the daemon owns its endpoint. */
  start(): void {
    this.marker.open()
    this.monitor.start()
    this.gate.startHostTerminals()
  }

  /** Called after every session was disposed on an orderly shutdown. */
  stop(): void {
    this.monitor.stop()
    this.gate.stopHostTerminals()
    this.marker.markCleanExit()
  }

  /** An exit on purpose that skips teardown (macOS login-session retirement). */
  recordOrderlyExit(): void {
    this.monitor.stop()
    this.gate.stopHostTerminals()
    this.marker.markCleanExit()
  }

  /** A stop requested from outside (SIGTERM/SIGINT), recorded before the teardown starts. */
  recordStopRequested(): void {
    this.marker.recordStopRequested()
  }

  status(): AutomaticWorkStatus {
    return {
      admission: this.options.mode,
      mode: this.automaticWorkMode(),
      legacyRestores: this.legacyRestores.list()
    }
  }

  handle(type: AutomaticWorkRequestType): AutomaticWorkStatus | AutomaticWorkResumeResult {
    return type === 'resumeAutomaticWork' ? this.resume() : this.status()
  }

  /** The operator's resume: clears a crash or pressure pause and lets waiting restores through. */
  resume(): AutomaticWorkResumeResult {
    const before = this.automaticWorkMode()
    this.marker.resume()
    this.pressurePausedSince = null
    this.gate.onPressureChanged()
    return { ...this.status(), cleared: before.kind === 'paused' ? before : null }
  }

  private onPressureChanged(level: HostPressureLevel): void {
    this.options.log.log('process-growth-level', { level })
    this.gate.onPressureChanged()
  }

  private automaticWorkMode(): AutomaticWorkMode {
    const recorded = this.marker.mode
    if (recorded.kind === 'paused' || this.pressurePausedSince === null) {
      return recorded
    }
    return { kind: 'paused', reason: 'pressure', since: this.pressurePausedSince }
  }

  private onTrip(trips: readonly ProcessGrowthTrip[]): void {
    // Why pause, not kill: running agents keep running and only new automatic work stops
    // (owner decision Q3). Why in memory for this run: an observe-only host must not leave
    // one behind for when it starts enforcing, and a resume or restart clears it.
    if (this.options.mode === 'enforce') {
      this.pressurePausedSince ??= Date.now()
    }
    this.options.log.log('process-growth-breaker-tripped', {
      trips: trips.map((trip) => ({
        scope: trip.scopeId === null ? 'host' : trip.scopeId.slice(-12),
        descendants: trip.descendants,
        growthPerSecond: trip.growthPerSecond
      }))
    })
  }
}
