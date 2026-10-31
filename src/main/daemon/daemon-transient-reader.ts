import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import { terminalSnapshotSchema } from '../../shared/terminal-transient-observation'
import type { DaemonEvent } from './daemon-stream-events'

/** Socket lifetime routing only; semantic watermarks live with the execution consumer. */
export class DaemonTransientReader {
  private disposed = false
  constructor(private readonly emit: (event: DaemonEvent) => void) {}
  dispose(): void {
    this.disposed = true
  }
  accept(event: DaemonEvent): void {
    if (this.disposed) {
      return
    }
    if (event.event === 'terminalObservation') {
      if (typeof event.sessionId !== 'string' || !isPtyIncarnationId(event.incarnationId)) {
        return
      }
      const state = terminalSnapshotSchema.safeParse(event.payload)
      if (state.success) {
        this.emit({ ...event, payload: state.data })
      }
      return
    }
    this.emit(event)
  }
}
