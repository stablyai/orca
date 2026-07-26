import type { PtyDataUpstreamCredit } from '../providers/pty-provider-events'

export const MAX_PENDING_PTY_DELIVERY_CREDIT_SPANS = 4096
export const MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS_PER_PTY = 4096
export const MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS = 16_384
export const MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES = 4096
export const MAX_RENDERER_PTY_DELIVERY_CREDIT_STATE_ID_BYTES = 8 * 1024 * 1024

export type PtyDeliveryCreditSpan =
  | {
      credit: PtyDataUpstreamCredit
      chars: number
      settled?: never
    }
  | {
      chars: number
      settled: true
      credit?: never
    }

type InFlightCreditSpan = {
  chars: number
  credit?: PtyDataUpstreamCredit
  settled?: true
}

type InFlightCreditState = {
  idBytes: number
  spans: InFlightCreditSpan[]
  settledPrefixChars: number
  settleFallback: (chars: number) => void
}

export function appendPtyDeliveryCredit(
  spans: PtyDeliveryCreditSpan[] | undefined,
  credit: PtyDataUpstreamCredit | undefined
): PtyDeliveryCreditSpan[] | undefined {
  if (!credit || !Number.isFinite(credit.charCount) || credit.charCount <= 0) {
    return spans
  }
  const chars = Math.floor(credit.charCount)
  const next = spans ?? []
  const tail = next.at(-1)
  if (tail?.settled === true) {
    credit.acknowledge(chars)
    tail.chars += chars
    return next
  }
  if (next.length >= MAX_PENDING_PTY_DELIVERY_CREDIT_SPANS) {
    let settledChars = chars
    for (const span of next) {
      settledChars += span.chars
      span.credit?.acknowledge(span.chars)
    }
    credit.acknowledge(chars)
    next.splice(0, next.length, { chars: settledChars, settled: true })
    return next
  }
  next.push({ credit, chars })
  return next
}

export function takePtyDeliveryCredit(
  spans: PtyDeliveryCreditSpan[] | undefined,
  requestedChars: number
): PtyDeliveryCreditSpan[] | undefined {
  if (!spans || spans.length === 0 || requestedChars <= 0) {
    return undefined
  }
  const taken: PtyDeliveryCreditSpan[] = []
  let remaining = requestedChars
  while (remaining > 0 && spans.length > 0) {
    const span = spans[0]
    const chars = Math.min(remaining, span.chars)
    taken.push(span.settled === true ? { chars, settled: true } : { credit: span.credit, chars })
    span.chars -= chars
    remaining -= chars
    if (span.chars === 0) {
      spans.shift()
    }
  }
  return taken
}

export function settlePtyDeliveryCredit(spans: PtyDeliveryCreditSpan[] | undefined): void {
  if (!spans) {
    return
  }
  for (const span of spans.splice(0)) {
    span.credit?.acknowledge(span.chars)
  }
}

export class PtyRendererDeliveryCreditLedger {
  private readonly inFlightByPty = new Map<string, InFlightCreditState>()
  private retainedSpanCount = 0
  private retainedStateIdBytes = 0

  recordSent(
    id: string,
    charCount: number,
    explicitCredit: PtyDeliveryCreditSpan[] | undefined,
    settleFallback: (chars: number) => void
  ): void {
    if (!Number.isFinite(charCount) || charCount <= 0) {
      return
    }
    const admittedCharCount = Math.floor(charCount)
    const state = this.inFlightByPty.get(id) ?? {
      idBytes: Buffer.byteLength(id, 'utf8'),
      spans: [],
      settledPrefixChars: 0,
      settleFallback
    }
    const isNewState = !this.inFlightByPty.has(id)
    state.settleFallback = settleFallback
    let recorded = 0
    for (const span of explicitCredit ?? []) {
      if (recorded >= admittedCharCount || !Number.isFinite(span.chars) || span.chars <= 0) {
        break
      }
      const chars = Math.min(Math.floor(span.chars), admittedCharCount - recorded)
      this.appendSpan(
        state,
        span.settled === true ? { chars, settled: true } : { chars, credit: span.credit }
      )
      recorded += chars
    }
    if (recorded < admittedCharCount) {
      this.appendSpan(state, { chars: admittedCharCount - recorded })
    }
    this.inFlightByPty.delete(id)
    this.inFlightByPty.set(id, state)
    if (isNewState) {
      this.retainedStateIdBytes += state.idBytes
    }
    this.capStates()
  }

  acknowledge(id: string, charCount: number, acknowledgeFallback: (chars: number) => void): void {
    const state = this.inFlightByPty.get(id)
    if (!state || !Number.isFinite(charCount) || charCount <= 0) {
      return
    }
    let remaining = Math.floor(charCount)
    const settledPrefix = Math.min(remaining, state.settledPrefixChars)
    state.settledPrefixChars -= settledPrefix
    remaining -= settledPrefix
    let fallbackChars = 0
    while (remaining > 0 && state.spans.length > 0) {
      const span = state.spans[0]
      const chars = Math.min(remaining, span.chars)
      if (span.credit) {
        span.credit.acknowledge(chars)
      } else if (span.settled !== true) {
        fallbackChars += chars
      }
      span.chars -= chars
      remaining -= chars
      if (span.chars === 0) {
        state.spans.shift()
        this.retainedSpanCount--
      }
    }
    if (state.spans.length === 0 && state.settledPrefixChars === 0) {
      this.deleteState(id, state)
    }
    if (fallbackChars > 0) {
      acknowledgeFallback(fallbackChars)
    }
  }

  writeOff(id: string, acknowledgeFallback: (chars: number) => void): void {
    const state = this.inFlightByPty.get(id)
    if (!state) {
      return
    }
    this.acknowledge(
      id,
      state.settledPrefixChars + state.spans.reduce((total, span) => total + span.chars, 0),
      acknowledgeFallback
    )
  }

  writeOffAll(acknowledgeFallback: (id: string, chars: number) => void): void {
    for (const id of Array.from(this.inFlightByPty.keys())) {
      this.writeOff(id, (chars) => acknowledgeFallback(id, chars))
    }
  }

  abandon(id: string): void {
    const state = this.inFlightByPty.get(id)
    if (!state) {
      return
    }
    this.retainedSpanCount -= state.spans.length
    this.deleteState(id, state)
  }

  private appendSpan(state: InFlightCreditState, span: InFlightCreditSpan): void {
    if (span.chars <= 0) {
      return
    }
    let tail = state.spans.at(-1)
    if (tail && this.canMergeSpans(tail, span)) {
      tail.chars += span.chars
      return
    }
    this.ensureSpanCapacity(state)
    tail = state.spans.at(-1)
    if (tail && this.canMergeSpans(tail, span)) {
      tail.chars += span.chars
      return
    }
    state.spans.push(span)
    this.retainedSpanCount++
  }

  private capStates(): void {
    while (
      this.inFlightByPty.size > MAX_RENDERER_PTY_DELIVERY_CREDIT_STATES ||
      this.retainedStateIdBytes > MAX_RENDERER_PTY_DELIVERY_CREDIT_STATE_ID_BYTES
    ) {
      const oldest = this.inFlightByPty.entries().next().value as
        | [string, InFlightCreditState]
        | undefined
      if (!oldest) {
        return
      }
      this.collapseState(oldest[1])
      this.deleteState(oldest[0], oldest[1])
    }
  }

  private ensureSpanCapacity(state: InFlightCreditState): void {
    if (
      state.spans.length >= MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS_PER_PTY ||
      this.retainedSpanCount >= MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS
    ) {
      this.collapseState(state)
    }
    while (this.retainedSpanCount >= MAX_RENDERER_PTY_DELIVERY_CREDIT_SPANS) {
      const candidate = Array.from(this.inFlightByPty.values()).find(
        (entry) => entry.spans.length > 0
      )
      if (!candidate) {
        break
      }
      this.collapseState(candidate)
    }
  }

  private collapseState(state: InFlightCreditState): void {
    if (state.spans.length === 0) {
      return
    }
    let settledChars = 0
    let fallbackChars = 0
    for (const span of state.spans) {
      settledChars += span.chars
      try {
        if (span.credit) {
          span.credit.acknowledge(span.chars)
        } else if (span.settled !== true) {
          fallbackChars += span.chars
        }
      } catch {
        // Why: overload shedding must still release local metadata if an upstream is gone.
      }
    }
    if (fallbackChars > 0) {
      try {
        state.settleFallback(fallbackChars)
      } catch {
        // Why: overload shedding must still release local metadata if an upstream is gone.
      }
    }
    state.settledPrefixChars += settledChars
    this.retainedSpanCount -= state.spans.length
    state.spans.length = 0
  }

  private deleteState(id: string, state: InFlightCreditState): void {
    if (this.inFlightByPty.get(id) !== state) {
      return
    }
    this.inFlightByPty.delete(id)
    this.retainedStateIdBytes -= state.idBytes
  }

  private canMergeSpans(left: InFlightCreditSpan, right: InFlightCreditSpan): boolean {
    if (left.credit || right.credit) {
      return left.credit !== undefined && left.credit === right.credit
    }
    return left.settled === right.settled
  }
}
