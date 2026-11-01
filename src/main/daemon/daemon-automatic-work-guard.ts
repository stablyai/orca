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
import type { HostTerminalPolicy } from './host-terminal-policy'
import { TerminalSpawnGate, type TerminalSpawnAdmissionMode } from './terminal-spawn-gate'

type DaemonAutomaticWorkGuardOptions = {
  markerPath: string | undefined
  /** Where every daemon on this host shares its terminal count; undefined caps this one alone. */
  hostTerminalLedgerDir?: string | undefined
  terminalPolicy?: HostTerminalPolicy
  mode: TerminalSpawnAdmissionMode
  log: { log: (event: string, details: Record<string, unknown>) => void }
  listSessions: () => readonly { sessionId: string; pid: number | null }[]
  ownsEndpoint: () => boolean
  monitor?: DaemonProcessGrowthMonitor
}

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
    const policy = options.terminalPolicy
    this.gate = new TerminalSpawnGate({
      log: (event, details) => options.log.log(event, details),
      mode: options.mode,
      pressure: () => this.monitor.level,
      automaticWorkMode: () => this.automaticWorkMode(),
      armAutomaticWork: () => this.marker.arm(),
      legacyRestores: this.legacyRestores,
      resolveMaximum: policy ? () => policy.admissionMaximum() : undefined,
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

  /** Stop only after orderly disposal of all sessions. */
  stop(): void {
    this.monitor.stop()
    this.gate.stopHostTerminals()
    this.marker.markCleanExit()
  }

  /** Record intentional exits that bypass session teardown, such as macOS login retirement. */
  recordOrderlyExit(): void {
    this.monitor.stop()
    this.gate.stopHostTerminals()
    this.marker.markCleanExit()
  }

  /** Record external stop signals before teardown starts. */
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
    // Pause new automatic work without killing agents; keep pressure pauses in memory for this run.
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
