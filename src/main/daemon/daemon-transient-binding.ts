import type { DaemonEvent, TerminalObservationEvent } from './daemon-stream-events'
import { streamEventJsonBytes } from './daemon-transient-accounting'
import type {
  TerminalTransientObservation,
  TerminalTransientSink
} from '../../shared/terminal-transient-observation'
import type { DaemonTransientAdmission } from './daemon-transient-admission'
import type { AdmittedTransientRecord, RecordCounter } from './daemon-transient-accounting'

const RECORD_BYTES = 16 * 1024
const RECORD_OVERHEAD = 1024

export class TransientBinding implements TerminalTransientSink {
  incarnationId = ''
  epoch = 0
  dirty = true
  unencodable = false
  readonly counter: RecordCounter = { bytes: 0, records: 0 }
  staged: AdmittedTransientRecord[] = []
  readCurrent: (() => TerminalTransientObservation) | null = null
  constructor(
    readonly owner: DaemonTransientAdmission,
    readonly sessionId: string,
    readonly subscriptionId: string,
    readonly streamId: string
  ) {}
  install(
    current: TerminalTransientObservation,
    incarnationId: string,
    readCurrent: () => TerminalTransientObservation
  ): void {
    this.incarnationId = incarnationId
    this.readCurrent = readCurrent
    this.unencodable = false
    this.owner.install(this, current)
  }
  stage(observation: TerminalTransientObservation): void {
    this.owner.stage(this, observation)
  }
  commit(): void {
    this.owner.commit(this)
  }
  dispose(): void {
    this.owner.unbind(this)
  }
  admit(payload: TerminalTransientObservation): AdmittedTransientRecord | null {
    const event: TerminalObservationEvent = {
      type: 'event',
      event: 'terminalObservation',
      subscriptionId: this.subscriptionId,
      streamId: this.streamId,
      incarnationId: this.incarnationId,
      epoch: this.epoch,
      payload
    }
    return this.admitEvent(event)
  }

  admitEvent(event: DaemonEvent): AdmittedTransientRecord | null {
    const upper = 5 + streamEventJsonBytes(event)
    const peak = 3 * upper + RECORD_OVERHEAD
    if (upper > RECORD_BYTES) {
      this.unencodable =
        event.event === 'data' ||
        (event.event === 'terminalObservation' && event.payload.kind === 'install')
      return null
    }
    const lease = this.owner.reserve(this.counter, peak)
    if (!lease) {
      return null
    }
    const buffer = this.owner.encodeQueued(lease, event, this.owner.framing)
    if (!buffer) {
      lease.release()
      return null
    }
    return Object.assign(lease, { buffer, installBoundary: false })
  }
}
