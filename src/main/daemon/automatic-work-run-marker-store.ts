import { readFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { AutomaticWorkMode } from '../../shared/host-spawn-admission'
import {
  decideStartupAutomaticWorkMode,
  parseAutomaticWorkRunMarker,
  type AutomaticWorkRunMarker as AutomaticWorkRunMarkerFile,
  type BootIdentity
} from '../../shared/automatic-work-run-marker'

const PRIVATE_FILE_MODE = 0o600

// Protocol generations share a runtime directory but must never overwrite each other's run markers.
export function automaticWorkMarkerPathFor(pidRecordPath: string): string {
  return `${pidRecordPath.replace(/\.pid$/, '')}.automatic-work-run.json`
}

export function readBootIdentity(now: number = Date.now()): BootIdentity {
  let bootId: string | null = null
  if (process.platform === 'linux') {
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
    } catch {
      bootId = null
    }
  }
  // Windows Fast Startup preserves uptime across shutdowns, so boot time cannot safely pause restores.
  return { bootTimeMs: process.platform === 'win32' ? null : now - uptime() * 1000, bootId }
}

function readPreviousMarker(path: string): AutomaticWorkRunMarkerFile | null {
  try {
    return parseAutomaticWorkRunMarker(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Open only after winning the endpoint; marker I/O failures must not block restores. */
export class AutomaticWorkRunMarker {
  private currentMode: AutomaticWorkMode = { kind: 'normal' }
  private opened = false
  private armRequested = false
  private armed = false
  private stopRequested = false
  private boot: BootIdentity | null = null

  constructor(
    private readonly path: string | undefined,
    private readonly logger: { log: (event: string, details: Record<string, unknown>) => void },
    /** A replaced daemon must not rewrite its successor's marker. */
    private readonly ownsEndpoint: () => boolean = () => true
  ) {}

  open(now: number = Date.now(), boot: BootIdentity = readBootIdentity(now)): void {
    if (this.opened || !this.path) {
      return
    }
    this.opened = true
    this.boot = boot
    const previous = readPreviousMarker(this.path)
    this.currentMode = decideStartupAutomaticWorkMode(previous, boot, now)
    if (this.currentMode.kind === 'paused') {
      this.log('automatic-work-paused', {
        reason: this.currentMode.reason,
        carriedOver: previous?.mode.kind === 'paused'
      })
    }
    this.writeSync(this.armRequested ? 'running' : 'clean-exit')
    this.armed = this.armRequested
  }

  get mode(): AutomaticWorkMode {
    return this.currentMode
  }

  gateOptions(): { automaticWorkMode: () => AutomaticWorkMode; armAutomaticWork: () => void } {
    return { automaticWorkMode: () => this.currentMode, armAutomaticWork: () => this.arm() }
  }

  /** Write synchronously before automatic forks so a late running write cannot overwrite clean-exit. */
  arm(): void {
    this.armRequested = true
    if (!this.opened || this.armed) {
      return
    }
    this.armed = true
    this.writeSync('running')
  }

  /** Resume only on explicit operator action. */
  resume(): void {
    if (this.currentMode.kind === 'normal') {
      return
    }
    this.log('automatic-work-resumed', { reason: this.currentMode.reason })
    this.currentMode = { kind: 'normal' }
    if (this.opened) {
      this.writeSync(this.armed ? 'running' : 'clean-exit')
    }
  }

  markCleanExit(): void {
    if (this.opened) {
      this.writeSync('clean-exit')
    }
  }

  /** Mark clean before external-stop teardown, which may kill the daemon before markCleanExit(). */
  recordStopRequested(): void {
    this.stopRequested = true
    if (this.opened) {
      this.writeSync('clean-exit')
    }
  }

  private writeSync(state: AutomaticWorkRunMarkerFile['state']): void {
    if (!this.path || !this.boot || !this.ownsEndpoint()) {
      return
    }
    const marker: AutomaticWorkRunMarkerFile = {
      schemaVersion: 1,
      boot: this.boot,
      state: this.stopRequested ? 'clean-exit' : state,
      mode: this.currentMode
    }
    try {
      writeFileDurableSync(
        durableWriteTempPath(this.path),
        this.path,
        JSON.stringify(marker),
        PRIVATE_FILE_MODE
      )
    } catch (error) {
      this.log('automatic-work-marker-write-failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private log(event: string, details: Record<string, unknown>): void {
    try {
      this.logger.log(event, details)
    } catch {
      // Diagnostics never block terminal work.
    }
  }
}
