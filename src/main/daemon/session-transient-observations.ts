import { TerminalSnapshotObserver } from '../../shared/terminal-snapshot-observer'
import type { TerminalTransientObservation } from '../../shared/terminal-transient-observation'

/** The Session owns genuine-byte interpretation and local live-process recognition. */
export class SessionTransientObservations {
  private readonly observer: TerminalSnapshotObserver

  constructor(
    publish: (observation: TerminalTransientObservation) => void,
    adopted = false,
    startupCommand?: string
  ) {
    this.observer = new TerminalSnapshotObserver(publish, {
      adopted,
      startupCommand
    })
  }

  observe(data: string, rawEndSeq: number): void {
    this.observer.observe(data, rawEndSeq)
  }
  snapshot(): TerminalTransientObservation {
    return this.observer.snapshot()
  }
  dispose(): void {
    this.observer.dispose()
  }
}
