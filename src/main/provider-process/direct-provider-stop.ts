import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  type ProviderSpawnSpec
} from './provider-process-supervisor'

export type ProviderControlCommand = 'stdin-end' | 'term' | 'reap' | 'leader-exit'

/** The native watcher owns deadlines; this runtime only backs up a stalled watcher. */
export class DirectProviderStop {
  private phase: 'idle' | 'stdin' | 'term' | 'reap' = 'idle'
  private watchdog?: NodeJS.Timeout

  constructor(
    private readonly spec: ProviderSpawnSpec,
    private readonly send: (command: ProviderControlCommand) => void,
    private readonly forceReap: () => boolean
  ) {}

  get reaping(): boolean {
    return this.phase === 'reap'
  }
  get canEndStdin(): boolean {
    return this.spec.lifetime === 'session' && this.phase === 'idle'
  }

  stdinEnded(): void {
    this.phase = 'stdin'
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

  reap(): void {
    this.complete()
    this.send('reap')
  }

  complete(): void {
    this.phase = 'reap'
    clearTimeout(this.watchdog)
  }

  private backupAfter(graceMs: number): void {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(this.forceReap, graceMs + PROVIDER_GROUP_REAP_TIMEOUT_MS)
  }
}
