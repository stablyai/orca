import type { DeliveryRecord } from './pty-source-credit-record'

export type PtySourceCreditRetentionSnapshot = Readonly<{
  sourceSu: number
  dataBytes: number
  spans: number
}>

type RecordRetention = PtySourceCreditRetentionSnapshot

export class PtySourceCreditRetention {
  private sourceSuTotal = 0
  private dataBytesTotal = 0
  private spansTotal = 0

  addSpan(sourceSu: number, dataBytes: number): void {
    this.sourceSuTotal += sourceSu
    this.dataBytesTotal += dataBytes
    this.spansTotal += 1
  }

  addRecord(record: DeliveryRecord): void {
    this.apply(recordRetention(record), 1)
  }

  removeRecord(record: DeliveryRecord): void {
    this.apply(recordRetention(record), -1)
  }

  trackMutation<T>(record: DeliveryRecord, mutate: () => T): T {
    const before = recordRetention(record)
    try {
      return mutate()
    } finally {
      const after = recordRetention(record)
      this.sourceSuTotal += after.sourceSu - before.sourceSu
      this.dataBytesTotal += after.dataBytes - before.dataBytes
      this.spansTotal += after.spans - before.spans
    }
  }

  retainedSourceSu = (): number => this.sourceSuTotal

  retainedDataBytes = (): number => this.dataBytesTotal

  retainedSpans = (): number => this.spansTotal

  snapshot(): PtySourceCreditRetentionSnapshot {
    return Object.freeze({
      sourceSu: this.sourceSuTotal,
      dataBytes: this.dataBytesTotal,
      spans: this.spansTotal
    })
  }

  private apply(retention: RecordRetention, direction: 1 | -1): void {
    this.sourceSuTotal += direction * retention.sourceSu
    this.dataBytesTotal += direction * retention.dataBytes
    this.spansTotal += direction * retention.spans
  }
}

function recordRetention(record: DeliveryRecord): RecordRetention {
  return {
    sourceSu: record.receivedEndSu - record.creditedEndSu,
    dataBytes: record.retainedDataBytes,
    spans: record.spans.length
  }
}
