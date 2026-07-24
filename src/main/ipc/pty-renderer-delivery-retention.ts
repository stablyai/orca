import {
  MAX_RENDERER_PTY_DELIVERY_CREDIT_STATE_ID_BYTES,
  MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES,
  type PtyDeliveryCreditSpan
} from './pty-renderer-delivery-credit'

export const MAX_PENDING_PTY_DATA_STATES = MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES
export const MAX_PENDING_PTY_DATA_ID_BYTES = MAX_RENDERER_PTY_DELIVERY_CREDIT_STATE_ID_BYTES
export const MAX_PENDING_PTY_DATA_CHARS = 32 * 1024 * 1024
export const MAX_PENDING_PTY_DATA_CREDIT_SPANS = 16_384
export const MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES = MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES
export const MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_ID_BYTES =
  MAX_RENDERER_PTY_DELIVERY_CREDIT_STATE_ID_BYTES

type PendingPtyDataMeasurement = {
  chars: number
  creditSpans: number
}

export class PendingPtyDataMap<T> extends Map<string, T> {
  private readonly measurements = new Map<string, PendingPtyDataMeasurement>()
  private retainedChars = 0
  private retainedCreditSpans = 0
  private retainedIdBytes = 0

  constructor(
    private readonly measure: (value: T) => PendingPtyDataMeasurement,
    private readonly onRejected: (id: string, value: T) => void
  ) {
    super()
  }

  admit(id: string, value: T): boolean {
    const hadPrevious = super.has(id)
    const previousMeasurement = this.measurements.get(id) ?? { chars: 0, creditSpans: 0 }
    const measurement = this.measure(value)
    const idBytes = Buffer.byteLength(id, 'utf8')
    const nextSize = this.size + (hadPrevious ? 0 : 1)
    const nextIdBytes = this.retainedIdBytes + (hadPrevious ? 0 : idBytes)
    const nextChars = this.retainedChars - previousMeasurement.chars + measurement.chars
    const nextCreditSpans =
      this.retainedCreditSpans - previousMeasurement.creditSpans + measurement.creditSpans

    if (
      nextSize > MAX_PENDING_PTY_DATA_STATES ||
      nextIdBytes > MAX_PENDING_PTY_DATA_ID_BYTES ||
      nextChars > MAX_PENDING_PTY_DATA_CHARS ||
      nextCreditSpans > MAX_PENDING_PTY_DATA_CREDIT_SPANS
    ) {
      if (hadPrevious) {
        this.delete(id)
      }
      this.onRejected(id, value)
      return false
    }

    super.set(id, value)
    this.measurements.set(id, measurement)
    this.retainedChars = nextChars
    this.retainedCreditSpans = nextCreditSpans
    this.retainedIdBytes = nextIdBytes
    return true
  }

  override set(id: string, value: T): this {
    this.admit(id, value)
    return this
  }

  override delete(id: string): boolean {
    const measurement = this.measurements.get(id) ?? { chars: 0, creditSpans: 0 }
    if (!super.delete(id)) {
      return false
    }
    this.measurements.delete(id)
    this.retainedChars -= measurement.chars
    this.retainedCreditSpans -= measurement.creditSpans
    this.retainedIdBytes -= Buffer.byteLength(id, 'utf8')
    return true
  }

  override clear(): void {
    super.clear()
    this.measurements.clear()
    this.retainedChars = 0
    this.retainedCreditSpans = 0
    this.retainedIdBytes = 0
  }
}

export class PtyRendererDeliveryAccountingMap<T> extends Map<string, T> {
  private retainedIdBytes = 0

  admit(id: string, value: T): boolean {
    if (super.has(id)) {
      super.set(id, value)
      return true
    }
    const idBytes = Buffer.byteLength(id, 'utf8')
    if (
      this.size >= MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES ||
      this.retainedIdBytes + idBytes > MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_ID_BYTES
    ) {
      return false
    }
    super.set(id, value)
    this.retainedIdBytes += idBytes
    return true
  }

  override set(id: string, value: T): this {
    this.admit(id, value)
    return this
  }

  override delete(id: string): boolean {
    if (!super.delete(id)) {
      return false
    }
    this.retainedIdBytes -= Buffer.byteLength(id, 'utf8')
    return true
  }

  override clear(): void {
    super.clear()
    this.retainedIdBytes = 0
  }
}

export class PtyRendererDeliveryIdSet extends Set<string> {
  private retainedIdBytes = 0

  remember(id: string): boolean {
    if (super.has(id)) {
      return false
    }
    const idBytes = Buffer.byteLength(id, 'utf8')
    if (
      this.size >= MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_STATES ||
      this.retainedIdBytes + idBytes > MAX_RENDERER_PTY_DELIVERY_ACCOUNTING_ID_BYTES
    ) {
      return false
    }
    super.add(id)
    this.retainedIdBytes += idBytes
    return true
  }

  override add(id: string): this {
    this.remember(id)
    return this
  }

  override delete(id: string): boolean {
    if (!super.delete(id)) {
      return false
    }
    this.retainedIdBytes -= Buffer.byteLength(id, 'utf8')
    return true
  }

  override clear(): void {
    super.clear()
    this.retainedIdBytes = 0
  }
}

export function settleRejectedPtyRendererDelivery(
  charCount: number,
  creditSpans: PtyDeliveryCreditSpan[] | undefined,
  settleFallback: (chars: number) => void
): void {
  if (!Number.isFinite(charCount) || charCount <= 0) {
    return
  }
  let remaining = Math.floor(charCount)
  for (const span of creditSpans ?? []) {
    if (remaining <= 0 || !Number.isFinite(span.chars) || span.chars <= 0) {
      continue
    }
    const chars = Math.min(remaining, Math.floor(span.chars))
    remaining -= chars
    span.credit?.acknowledge(chars)
  }
  if (remaining > 0) {
    settleFallback(remaining)
  }
}
