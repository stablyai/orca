import { RecentPtyOutputBuffer } from '../main/runtime/recent-pty-output-buffer'
import { ptySourceSpanIsSplittable, type PtySourceSpan } from '../shared/pty-source-credit-contract'
import {
  assertNonNegativeSafeInteger,
  assertPtySourceSpan
} from '../shared/pty-source-credit-validation'

export type PtySourceReplayRecord = Readonly<
  Pick<
    PtySourceSpan,
    | 'spanId'
    | 'sourceStartSu'
    | 'sourceEndSu'
    | 'displayStart'
    | 'displayEnd'
    | 'data'
    | 'splittable'
    | 'indivisible'
    | 'transform'
  >
>

export type PtySourceReplayResult =
  | Readonly<{ ok: true; records: readonly PtySourceReplayRecord[]; liveEndSourceSu: number }>
  | Readonly<{
      ok: false
      reason:
        | 'checkpoint-before-retained-range'
        | 'checkpoint-after-live-range'
        | 'checkpoint-inside-indivisible-transform'
        | 'checkpoint-inside-scalar'
      retainedStartSourceSu: number
      liveEndSourceSu: number
    }>

export class PtySourceReplayIndex {
  private readonly output: RecentPtyOutputBuffer
  private readonly records: PtySourceReplayRecord[] = []
  private displayEnd = 0
  private retainedStartSourceSu = 0
  private liveEndSourceSu = 0

  constructor(limit: number) {
    this.output = new RecentPtyOutputBuffer({ preserveChunkBoundaries: false, limit })
  }

  append(span: PtySourceSpan): void {
    assertPtySourceSpan(span)
    if (
      span.sourceStartSu !== this.liveEndSourceSu ||
      span.displayStart !== this.displayEnd ||
      span.displayEnd - span.displayStart !== span.data.length
    ) {
      throw new Error('PTY replay source/display ranges must be contiguous')
    }
    this.output.append(span.data)
    this.records.push(
      Object.freeze({
        spanId: span.spanId,
        sourceStartSu: span.sourceStartSu,
        sourceEndSu: span.sourceEndSu,
        displayStart: span.displayStart,
        displayEnd: span.displayEnd,
        data: span.data,
        splittable: span.splittable,
        indivisible: span.indivisible,
        transform: span.transform
      })
    )
    this.displayEnd = span.displayEnd
    this.liveEndSourceSu = span.sourceEndSu
    this.evictUnmappedPrefix()
  }

  readLegacy(): string {
    return this.output.read()
  }

  recoveryFrom(checkpointSourceEndSu: number): PtySourceReplayResult {
    assertNonNegativeSafeInteger(checkpointSourceEndSu, 'checkpointSourceEndSu')
    if (checkpointSourceEndSu < this.retainedStartSourceSu) {
      return Object.freeze({
        ok: false,
        reason: 'checkpoint-before-retained-range',
        retainedStartSourceSu: this.retainedStartSourceSu,
        liveEndSourceSu: this.liveEndSourceSu
      })
    }
    if (checkpointSourceEndSu > this.liveEndSourceSu) {
      return Object.freeze({
        ok: false,
        reason: 'checkpoint-after-live-range',
        retainedStartSourceSu: this.retainedStartSourceSu,
        liveEndSourceSu: this.liveEndSourceSu
      })
    }
    const containing = this.records.find(
      (record) =>
        record.sourceStartSu < checkpointSourceEndSu && checkpointSourceEndSu < record.sourceEndSu
    )
    if (
      containing?.transform.transformed ||
      (containing && !ptySourceSpanIsSplittable(containing))
    ) {
      return Object.freeze({
        ok: false,
        reason: 'checkpoint-inside-indivisible-transform',
        retainedStartSourceSu: this.retainedStartSourceSu,
        liveEndSourceSu: this.liveEndSourceSu
      })
    }
    if (
      containing &&
      splitsSurrogatePair(containing.data, checkpointSourceEndSu - containing.sourceStartSu)
    ) {
      return Object.freeze({
        ok: false,
        reason: 'checkpoint-inside-scalar',
        retainedStartSourceSu: this.retainedStartSourceSu,
        liveEndSourceSu: this.liveEndSourceSu
      })
    }
    const records = this.records
      .filter((record) => record.sourceEndSu > checkpointSourceEndSu)
      .map((record) => this.sliceRecord(record, checkpointSourceEndSu))
    return Object.freeze({
      ok: true,
      records: Object.freeze(records),
      liveEndSourceSu: this.liveEndSourceSu
    })
  }

  private evictUnmappedPrefix(): void {
    const retainedDisplayStart = this.displayEnd - this.output.read().length
    while (this.records[0]?.displayEnd <= retainedDisplayStart) {
      const removed = this.records.shift()!
      this.retainedStartSourceSu = removed.sourceEndSu
    }
    const head = this.records[0]
    if (!head || head.displayStart >= retainedDisplayStart) {
      return
    }
    if (head.transform.transformed || !ptySourceSpanIsSplittable(head)) {
      this.records.shift()
      this.retainedStartSourceSu = head.sourceEndSu
      return
    }
    const displayOffset = retainedDisplayStart - head.displayStart
    if (splitsSurrogatePair(head.data, displayOffset)) {
      this.records.shift()
      this.retainedStartSourceSu = head.sourceEndSu
      return
    }
    const sourceStartSu = head.sourceStartSu + displayOffset
    this.records[0] = Object.freeze({
      ...head,
      spanId: `${head.spanId}:retained:${sourceStartSu}`,
      sourceStartSu,
      displayStart: retainedDisplayStart,
      data: head.data.slice(displayOffset),
      transform: Object.freeze({
        ...head.transform,
        rawLengthSu: head.sourceEndSu - sourceStartSu
      })
    })
    this.retainedStartSourceSu = sourceStartSu
  }

  private sliceRecord(
    record: PtySourceReplayRecord,
    checkpointSourceEndSu: number
  ): PtySourceReplayRecord {
    if (checkpointSourceEndSu <= record.sourceStartSu) {
      return record
    }
    const offset = checkpointSourceEndSu - record.sourceStartSu
    return Object.freeze({
      ...record,
      spanId: `${record.spanId}:recovery:${checkpointSourceEndSu}`,
      sourceStartSu: checkpointSourceEndSu,
      displayStart: record.displayStart + offset,
      data: record.data.slice(offset),
      transform: Object.freeze({
        ...record.transform,
        rawLengthSu: record.sourceEndSu - checkpointSourceEndSu
      })
    })
  }
}

function splitsSurrogatePair(data: string, offset: number): boolean {
  const preceding = data.charCodeAt(offset - 1)
  const following = data.charCodeAt(offset)
  return (
    offset > 0 &&
    preceding >= 0xd800 &&
    preceding <= 0xdbff &&
    following >= 0xdc00 &&
    following <= 0xdfff
  )
}
