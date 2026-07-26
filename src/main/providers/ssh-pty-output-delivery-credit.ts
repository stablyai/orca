import type { PtyDataUpstreamCredit } from './pty-provider-events'
import {
  admittedSshRelayPtyIdBytes,
  isAdmittedSshDeliveryToken,
  isAdmittedSshRelayPtyId
} from './ssh-pty-wire-admission'

export const MAX_SSH_PTY_CREDIT_STATES = 256
export const MAX_SSH_PTY_CREDIT_STATE_ID_BYTES = 512 * 1024
export const MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE = 4096
export const MAX_SSH_PTY_CREDIT_SEGMENTS = 16_384

export type SshPtyOutputDelivery = {
  relayId: string
  data: string
  rawLength?: number
  transformed: boolean
  seq?: number
  upstreamCredit?: PtyDataUpstreamCredit
}

type AckParams = {
  id: string
  charCount: number
  deliveryToken?: string
}

export class SshPtyOutputDeliveryCredit {
  private readonly states = new Map<string, PtyCreditState>()
  private disposed = false
  private retainedStateIdBytes = 0
  private retainedSegments = 0

  constructor(private readonly notifyAck: (params: AckParams) => void) {}

  ingest(params: Record<string, unknown>, deliver: (output: SshPtyOutputDelivery) => void): void {
    const relayId = params.id
    const data = params.data
    if (!isAdmittedSshRelayPtyId(relayId) || typeof data !== 'string') {
      return
    }
    if (params.deliveryToken !== undefined && !isAdmittedSshDeliveryToken(params.deliveryToken)) {
      return
    }
    const deliveryToken = params.deliveryToken as string | undefined
    const rawLength =
      typeof params.rawLength === 'number' &&
      Number.isSafeInteger(params.rawLength) &&
      params.rawLength >= 0
        ? params.rawLength
        : undefined
    const seq =
      typeof params.seq === 'number' && Number.isSafeInteger(params.seq) && params.seq >= 0
        ? params.seq
        : undefined
    const charCount = rawLength ?? data.length
    const upstreamCredit = this.createCredit(relayId, charCount, deliveryToken)
    try {
      deliver({
        relayId,
        data,
        ...(rawLength === undefined ? {} : { rawLength }),
        transformed: params.transformed === true,
        ...(seq === undefined ? {} : { seq }),
        ...(upstreamCredit ? { upstreamCredit } : {})
      })
    } catch (error) {
      upstreamCredit?.acknowledge(charCount)
      throw error
    }
  }

  acknowledgeLegacy(relayId: string, charCount: number): void {
    if (
      !isAdmittedSshRelayPtyId(relayId) ||
      !Number.isFinite(charCount) ||
      charCount <= 0 ||
      this.disposed
    ) {
      return
    }
    const state = this.states.get(relayId)
    if (!state) {
      this.notifyAck({ id: relayId, charCount: Math.floor(charCount) })
      return
    }
    let remaining = Math.floor(charCount)
    while (remaining > 0 && state.segments.length > 0) {
      const segment = state.segments[0]
      const acknowledged = Math.min(remaining, segment.remainingChars)
      this.acknowledgeSegment(state, segment, acknowledged)
      remaining -= acknowledged
    }
    if (remaining > 0 && !state.tokenized) {
      this.notifyAck({ id: relayId, charCount: remaining })
    }
  }

  release(relayId: string): void {
    const state = this.states.get(relayId)
    if (!state) {
      return
    }
    this.removeState(state, false)
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.states.values()) {
      state.active = false
      this.clearSegments(state)
    }
    this.states.clear()
    this.retainedStateIdBytes = 0
  }

  private createCredit(
    relayId: string,
    charCount: number,
    deliveryToken: string | undefined
  ): PtyDataUpstreamCredit | undefined {
    if (this.disposed || charCount <= 0 || !deliveryToken) {
      return undefined
    }
    let existing = this.states.get(relayId)
    // Why: pty.attach rotates the relay token; stale renderer credit from the prior
    // generation must not pin every later acknowledged segment behind it.
    if (existing && existing.deliveryToken !== deliveryToken) {
      this.removeState(existing, false)
      existing = undefined
    }
    const state =
      existing?.active === true
        ? existing
        : {
            relayId,
            idBytes: admittedSshRelayPtyIdBytes(relayId) ?? 0,
            active: true,
            tokenized: true,
            deliveryToken,
            segments: [],
            directOutstandingChars: 0
          }
    if (!existing) {
      this.retainedStateIdBytes += state.idBytes
    } else {
      this.states.delete(relayId)
    }
    this.states.set(relayId, state)
    this.capStates()
    if (
      state.segments.length >= MAX_SSH_PTY_CREDIT_SEGMENTS_PER_STATE ||
      this.retainedSegments >= MAX_SSH_PTY_CREDIT_SEGMENTS
    ) {
      return this.createDirectCredit(state, charCount)
    }
    const segment: PtyCreditSegment = {
      deliveryToken,
      remainingChars: charCount
    }
    state.segments.push(segment)
    this.retainedSegments++
    return {
      charCount,
      acknowledge: (requestedChars) => {
        if (!Number.isFinite(requestedChars) || requestedChars <= 0) {
          return
        }
        this.acknowledgeSegment(state, segment, Math.floor(requestedChars))
      }
    }
  }

  private acknowledgeSegment(
    state: PtyCreditState,
    segment: PtyCreditSegment,
    requestedChars: number
  ): void {
    if (this.disposed || !state.active || requestedChars <= 0 || segment.remainingChars <= 0) {
      return
    }
    const charCount = Math.min(requestedChars, segment.remainingChars)
    segment.remainingChars -= charCount
    this.notifyAck({
      id: state.relayId,
      charCount,
      ...(segment.deliveryToken ? { deliveryToken: segment.deliveryToken } : {})
    })
    while (state.segments[0]?.remainingChars === 0) {
      state.segments.shift()
      this.retainedSegments--
    }
  }

  private createDirectCredit(state: PtyCreditState, charCount: number): PtyDataUpstreamCredit {
    let remainingChars = charCount
    state.directOutstandingChars += charCount
    return {
      charCount,
      acknowledge: (requestedChars) => {
        if (
          this.disposed ||
          !state.active ||
          state.deliveryToken.length === 0 ||
          !Number.isFinite(requestedChars) ||
          requestedChars <= 0 ||
          remainingChars <= 0
        ) {
          return
        }
        const acknowledged = Math.min(Math.floor(requestedChars), remainingChars)
        remainingChars -= acknowledged
        state.directOutstandingChars -= acknowledged
        this.notifyAck({
          id: state.relayId,
          charCount: acknowledged,
          deliveryToken: state.deliveryToken
        })
      }
    }
  }

  private capStates(): void {
    while (
      this.states.size > MAX_SSH_PTY_CREDIT_STATES ||
      this.retainedStateIdBytes > MAX_SSH_PTY_CREDIT_STATE_ID_BYTES
    ) {
      const oldest = this.states.values().next().value as PtyCreditState | undefined
      if (!oldest) {
        return
      }
      this.removeState(oldest, true)
    }
  }

  private removeState(state: PtyCreditState, returnOutstanding: boolean): void {
    state.active = false
    if (returnOutstanding) {
      const outstandingChars =
        state.directOutstandingChars +
        state.segments.reduce((total, segment) => total + segment.remainingChars, 0)
      if (outstandingChars > 0) {
        try {
          this.notifyAck({
            id: state.relayId,
            charCount: outstandingChars,
            deliveryToken: state.deliveryToken
          })
        } catch {
          // Best effort: eviction must still enforce the local memory bound.
        }
      }
    }
    state.directOutstandingChars = 0
    this.clearSegments(state)
    if (this.states.delete(state.relayId)) {
      this.retainedStateIdBytes -= state.idBytes
    }
  }

  private clearSegments(state: PtyCreditState): void {
    this.retainedSegments -= state.segments.length
    state.segments.length = 0
  }
}

type PtyCreditSegment = {
  deliveryToken?: string
  remainingChars: number
}

type PtyCreditState = {
  relayId: string
  idBytes: number
  active: boolean
  tokenized: boolean
  deliveryToken: string
  segments: PtyCreditSegment[]
  directOutstandingChars: number
}
