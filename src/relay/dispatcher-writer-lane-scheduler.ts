import type {
  DispatcherWriterAdmission,
  DispatcherWriterEntry,
  DispatcherWriterLane
} from './dispatcher-writer-admission'

const PRODUCER_WRITES_BEFORE_BULK = 4
const INTERACTIVE_WRITES_BEFORE_ORDINARY = 4

export class DispatcherWriterLaneScheduler {
  private producerWritesSinceBulk = 0
  private interactiveWritesSinceOrdinary = 0

  select(
    admission: DispatcherWriterAdmission,
    canWriteControl: (entry: DispatcherWriterEntry) => boolean,
    canWriteProducer: (entry: DispatcherWriterEntry) => boolean
  ): DispatcherWriterEntry | undefined {
    const liveness = admission.shift('liveness')
    if (liveness) {
      return liveness
    }
    const control = admission.peek('control')
    if (control && canWriteControl(control)) {
      return admission.shift('control')
    }
    const legacyResponse = admission.peek('legacy-response')
    if (legacyResponse && canWriteControl(legacyResponse)) {
      return admission.shift('legacy-response')
    }
    const bulk = admission.peek('fixed-bulk') ?? admission.peek('bulk')
    if (
      bulk &&
      this.producerWritesSinceBulk >= PRODUCER_WRITES_BEFORE_BULK &&
      canWriteProducer(bulk)
    ) {
      return admission.shift(bulk.lane)
    }
    const ordinary = admission.peek('ordinary')
    if (
      ordinary &&
      this.interactiveWritesSinceOrdinary >= INTERACTIVE_WRITES_BEFORE_ORDINARY &&
      canWriteProducer(ordinary)
    ) {
      return admission.shift('ordinary')
    }
    for (const lane of ['interactive', 'ordinary', 'fixed-bulk', 'bulk'] as const) {
      const candidate = admission.peek(lane)
      if (candidate && canWriteProducer(candidate)) {
        return admission.shift(lane)
      }
    }
    return undefined
  }

  recordWrite(lane: DispatcherWriterLane): void {
    if (lane === 'bulk' || lane === 'fixed-bulk') {
      this.producerWritesSinceBulk = 0
    } else if (lane === 'interactive' || lane === 'ordinary') {
      this.producerWritesSinceBulk = Math.min(
        PRODUCER_WRITES_BEFORE_BULK,
        this.producerWritesSinceBulk + 1
      )
    }
    if (lane === 'ordinary') {
      this.interactiveWritesSinceOrdinary = 0
    } else if (lane === 'interactive') {
      this.interactiveWritesSinceOrdinary = Math.min(
        INTERACTIVE_WRITES_BEFORE_ORDINARY,
        this.interactiveWritesSinceOrdinary + 1
      )
    }
  }
}
