import type { Writable } from 'node:stream'
import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  type ProviderSpawnSpec
} from './provider-process-supervisor'

export type ProviderControlCommand = 'stdin-end' | 'term' | 'reap' | 'leader-exit'

/** The native watcher owns deadlines; this runtime backs up a stalled watcher and stands in for a lost one. */
export class DirectProviderStop {
  private phase: 'idle' | 'stdin' | 'term' | 'reap' = 'idle'
  private watchdog?: NodeJS.Timeout
  private stdinDeadline = 0

  constructor(
    private readonly spec: ProviderSpawnSpec,
    private readonly control: () => Writable | undefined,
    private readonly forceReap: () => boolean
  ) {}

  get maxStopMs(): number {
    return this.spec.stdinEndGraceMs + this.spec.sigtermGraceMs + PROVIDER_GROUP_REAP_TIMEOUT_MS
  }

  get reaping(): boolean {
    return this.phase === 'reap'
  }
  get canEndStdin(): boolean {
    return this.spec.lifetime === 'session' && this.phase === 'idle'
  }

  stdinEnded(): void {
    this.phase = 'stdin'
    this.stdinDeadline = performance.now() + this.spec.stdinEndGraceMs
    this.send('stdin-end')
    this.backupAfter(this.spec.stdinEndGraceMs + this.spec.sigtermGraceMs)
  }

  term(): boolean {
    if (this.phase === 'term' || this.phase === 'reap') {
      return false
    }
    this.phase = 'term'
    this.send('term')
    this.backupAfter(this.spec.sigtermGraceMs)
    return true
  }

  leaderExited(released: boolean): void {
    if (this.reaping) {
      return
    }
    if (!released) {
      this.forceReap()
      return
    }
    // The watcher knows whether TERM actually started, even if this event loop was delayed.
    this.send('leader-exit')
    this.backupAfter(this.spec.lifetime === 'one-shot' ? 0 : this.spec.sigtermGraceMs)
  }

  /** The watcher's owner-EOF ladder for a lost parent or watcher; without the watcher, this times TERM. */
  ownerLost(watcherConnected: boolean, term: () => void): void {
    if (this.phase === 'idle' && !(this.canEndStdin && this.spec.closeRequest === 'stdin-end')) {
      term()
      return
    }
    if (this.phase === 'idle') {
      this.stdinEnded()
    }
    if (this.phase === 'stdin' && !watcherConnected) {
      clearTimeout(this.watchdog)
      this.watchdog = setTimeout(term, Math.max(0, this.stdinDeadline - performance.now()))
    } else if (this.phase === 'term' && !watcherConnected) {
      term()
    }
  }

  reap(): void {
    this.complete()
    this.send('reap')
  }

  complete(): void {
    this.phase = 'reap'
    clearTimeout(this.watchdog)
  }

  private send(command: ProviderControlCommand): void {
    const control = this.control()
    if (!control?.destroyed && control?.writable) {
      control.write(`${command}\n`)
    }
  }

  private backupAfter(graceMs: number): void {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(this.forceReap, graceMs + PROVIDER_GROUP_REAP_TIMEOUT_MS)
  }
}
