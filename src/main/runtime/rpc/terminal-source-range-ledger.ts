import {
  sameTerminalOutputSourceIdentity,
  type TerminalOutputSourceRange
} from '../../../shared/terminal-output-source-range'
import {
  canPlanTerminalSourceRangeReplacement,
  freezeTerminalOutputSourceRanges,
  replaceTerminalSourceRangeFrames,
  type TerminalSourceRangeFrame,
  validateTerminalSourceRangeFrame
} from './terminal-source-range-validation'

export type { TerminalSourceRangeFrame } from './terminal-source-range-validation'

export const TERMINAL_SOURCE_RANGE_STREAM_MAX_BYTES = 2 * 1024 * 1024

export type TerminalSourceRangeAckResult =
  | {
      status: 'accepted'
      acknowledgedBytes: number
      settled: readonly TerminalOutputSourceRange[]
    }
  | { status: 'duplicate'; settled: readonly [] }
  | {
      status: 'invalid' | 'stale-generation' | 'excessive' | 'cross-generation'
      settled: readonly []
    }

export type TerminalSourceRangeAdmission = Readonly<{
  frame: TerminalSourceRangeFrame
  commit: () => boolean
  rollback: () => void
}>

export type TerminalSourceRangeAdmissionResult =
  | { status: 'ready'; admission: TerminalSourceRangeAdmission }
  | { status: 'capacity' | 'invalid' | 'cross-generation' }

export type TerminalSourceRangeTransfer = Readonly<{
  frames: readonly TerminalSourceRangeFrame[]
  commit: () => void
  rollback: () => void
}>

export type TerminalSourceRangeBudget = {
  canReserve: (bytes: number) => boolean
  reserve: (bytes: number) => boolean
  release: (bytes: number) => void
  close: () => void
}

const STANDALONE_BUDGET: TerminalSourceRangeBudget = {
  canReserve: () => true,
  reserve: () => true,
  release: () => {},
  close: () => {}
}

function isRecoveredSourceIdentity(
  previous: TerminalOutputSourceRange,
  next: TerminalOutputSourceRange
): boolean {
  return (
    previous.id === next.id &&
    previous.providerGeneration === next.providerGeneration &&
    previous.ptyIncarnation === next.ptyIncarnation &&
    next.clientGeneration > previous.clientGeneration &&
    next.ownerGeneration > previous.ownerGeneration &&
    next.deliveryToken !== previous.deliveryToken
  )
}

export class TerminalSourceRangeLedger {
  private acceptedEndByte = 0
  private ackedEndByte = 0
  private retainedBytes = 0
  private frames: TerminalSourceRangeFrame[] = []
  private mappingMode: 'mapped' | 'unmapped' | null = null
  private boundRange: TerminalOutputSourceRange | null = null
  private mappedSourceEndSu: number | null = null
  private mappedDisplayEnd: number | null = null
  private pending: TerminalSourceRangeAdmission | null = null
  private transferring = false
  private closed = false

  constructor(
    readonly streamGeneration: string,
    private readonly budget: TerminalSourceRangeBudget = STANDALONE_BUDGET
  ) {
    if (!streamGeneration) {
      throw new Error('terminal_source_range_generation_required')
    }
  }

  canAccept(encodedBytes: number): boolean {
    return (
      !this.closed &&
      !this.transferring &&
      !this.pending &&
      Number.isSafeInteger(encodedBytes) &&
      encodedBytes > 0 &&
      this.retainedBytes + encodedBytes <= TERMINAL_SOURCE_RANGE_STREAM_MAX_BYTES &&
      this.budget.canReserve(encodedBytes)
    )
  }

  prepareAccept(
    encodedBytes: number,
    displayLength: number,
    sourceRanges: readonly TerminalOutputSourceRange[],
    outputSeq?: number
  ): TerminalSourceRangeAdmissionResult {
    if (!this.canAccept(encodedBytes)) {
      return { status: 'capacity' }
    }
    if (!validateTerminalSourceRangeFrame(displayLength, sourceRanges)) {
      return { status: 'invalid' }
    }
    const nextMappingMode = sourceRanges.length > 0 ? 'mapped' : 'unmapped'
    if (this.mappingMode && this.mappingMode !== nextMappingMode) {
      return { status: 'invalid' }
    }
    const first = sourceRanges[0]
    if (
      first &&
      (this.boundRange
        ? !sameTerminalOutputSourceIdentity(this.boundRange, first) &&
          !isRecoveredSourceIdentity(this.boundRange, first)
        : !sourceRanges.every((range) => sameTerminalOutputSourceIdentity(first, range)))
    ) {
      return { status: 'cross-generation' }
    }
    if (
      first &&
      ((this.mappedSourceEndSu !== null && first.sourceStartSu !== this.mappedSourceEndSu) ||
        (this.mappedDisplayEnd !== null && first.displayStart !== this.mappedDisplayEnd))
    ) {
      return { status: 'invalid' }
    }
    if (!this.budget.reserve(encodedBytes)) {
      return { status: 'capacity' }
    }
    const ranges = freezeTerminalOutputSourceRanges(sourceRanges)
    const frame = Object.freeze({
      encodedStartByte: this.acceptedEndByte,
      encodedEndByte: this.acceptedEndByte + encodedBytes,
      displayLength,
      ...(typeof outputSeq === 'number' ? { outputSeq } : {}),
      sourceRanges: ranges
    })
    let finished = false
    const admission: TerminalSourceRangeAdmission = Object.freeze({
      frame,
      commit: () => {
        if (finished || this.pending !== admission || this.closed || this.transferring) {
          return false
        }
        finished = true
        this.pending = null
        this.acceptedEndByte = frame.encodedEndByte
        this.retainedBytes += encodedBytes
        this.frames.push(frame)
        this.mappingMode ??= nextMappingMode
        const last = ranges.at(-1)
        if (first && last) {
          this.boundRange = first
          this.mappedSourceEndSu = last.sourceEndSu
          this.mappedDisplayEnd = last.displayEnd
        }
        return true
      },
      rollback: () => {
        if (finished) {
          return
        }
        finished = true
        if (this.pending === admission) {
          this.pending = null
        }
        this.budget.release(encodedBytes)
      }
    })
    this.pending = admission
    return { status: 'ready', admission }
  }

  accept(
    encodedBytes: number,
    displayLength: number,
    sourceRanges: readonly TerminalOutputSourceRange[],
    outputSeq?: number
  ): TerminalSourceRangeFrame | null {
    const prepared = this.prepareAccept(encodedBytes, displayLength, sourceRanges, outputSeq)
    if (prepared.status !== 'ready' || !prepared.admission.commit()) {
      return null
    }
    return prepared.admission.frame
  }

  acknowledge(streamGeneration: string, ackedEndByte: number): TerminalSourceRangeAckResult {
    if (streamGeneration !== this.streamGeneration) {
      return { status: 'stale-generation', settled: [] }
    }
    if (this.closed || this.transferring || this.pending) {
      return { status: 'invalid', settled: [] }
    }
    if (
      !Number.isSafeInteger(ackedEndByte) ||
      ackedEndByte < 0 ||
      ackedEndByte < this.ackedEndByte
    ) {
      return { status: 'invalid', settled: [] }
    }
    if (ackedEndByte > this.acceptedEndByte) {
      return { status: 'excessive', settled: [] }
    }
    if (ackedEndByte === this.ackedEndByte) {
      return { status: 'duplicate', settled: [] }
    }
    const acknowledgedBytes = ackedEndByte - this.ackedEndByte
    const settled: TerminalOutputSourceRange[] = []
    let frameCount = 0
    for (const frame of this.frames) {
      if (frame.encodedEndByte > ackedEndByte) {
        break
      }
      settled.push(...frame.sourceRanges)
      frameCount++
    }
    this.ackedEndByte = ackedEndByte
    this.frames.splice(0, frameCount)
    this.retainedBytes -= acknowledgedBytes
    this.budget.release(acknowledgedBytes)
    return { status: 'accepted', acknowledgedBytes, settled: Object.freeze(settled) }
  }

  planSourceRangeReplacement(snapshotSeq: number): Readonly<{ commit: () => void }> | null {
    const unavailable = this.closed || this.transferring || this.pending
    if (unavailable || !canPlanTerminalSourceRangeReplacement(this.frames, snapshotSeq)) {
      return null
    }
    const replacement = replaceTerminalSourceRangeFrames(this.frames, snapshotSeq)
    let committed = false
    return Object.freeze({
      commit: () => {
        if (committed || this.closed) {
          return
        }
        committed = true
        Object.assign(this, replacement)
      }
    })
  }

  beginTransfer(): TerminalSourceRangeTransfer {
    if (this.closed || this.transferring || this.pending) {
      throw new Error('terminal_source_range_transfer_invalid')
    }
    this.transferring = true
    let finished = false
    const frames = Object.freeze(this.frames.slice())
    return Object.freeze({
      frames,
      commit: () => {
        if (finished) {
          return
        }
        finished = true
        this.budget.release(this.retainedBytes)
        this.frames = []
        this.retainedBytes = 0
        this.transferring = false
        this.closed = true
        this.budget.close()
      },
      rollback: () => {
        if (finished) {
          return
        }
        finished = true
        this.transferring = false
      }
    })
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.pending?.rollback()
    this.budget.release(this.retainedBytes)
    this.frames = []
    this.retainedBytes = 0
    this.transferring = false
    this.closed = true
    this.budget.close()
  }

  getDebugSnapshot() {
    return {
      acceptedEndByte: this.acceptedEndByte,
      ackedEndByte: this.ackedEndByte,
      retainedBytes: this.retainedBytes,
      frames: this.frames.length,
      transferring: this.transferring,
      closed: this.closed,
      bound: this.boundRange !== null
    }
  }
}
