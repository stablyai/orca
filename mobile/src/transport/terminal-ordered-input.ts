import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'
import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../src/shared/terminal-ordered-input'
import type { TerminalStreamInputFailure } from './terminal-stream-input-failure'

type Limits = {
  version: 1
  maxFrameBytes: number
  maxPendingBytes: number
  maxPendingFrames: number
}
type Pending = {
  bytes: number
  resolve: (accepted: boolean) => void
  timer: ReturnType<typeof setTimeout>
}
type InputStream = {
  terminal: string
  streamId: number
  limits: Limits
  sequence: number
  failed: boolean
  failure: TerminalStreamInputFailure | null
  registration: number
  failureRegistration: number
  pendingBytes: number
  pending: Map<number, Pending>
}

export function advertiseTerminalOrderedInput(method: string, params: unknown): unknown {
  if (method !== 'terminal.subscribe' || !params || typeof params !== 'object') {
    return params
  }
  const existing = (params as { capabilities?: unknown }).capabilities
  return {
    ...params,
    capabilities: { ...(existing && typeof existing === 'object' ? existing : {}), orderedInput: 1 }
  }
}

export class TerminalOrderedInput {
  private readonly streams = new Map<string, InputStream>()
  private readonly byTerminal = new Map<string, InputStream>()
  private registration = 0
  constructor(private readonly sendBinary: (bytes: Uint8Array) => boolean) {}

  supports(terminal: string): boolean {
    return this.byTerminal.has(terminal)
  }

  failure(terminal: string): TerminalStreamInputFailure | null {
    return this.byTerminal.get(terminal)?.failure ?? null
  }

  recover(terminal: string): boolean {
    const failed = this.byTerminal.get(terminal)
    if (!failed?.failed) {
      return !!failed && failed.sequence === 0
    }
    const fresh = [...this.streams.values()].findLast(
      (stream) =>
        stream.terminal === terminal &&
        !stream.failed &&
        stream.sequence === 0 &&
        stream.registration > failed.failureRegistration
    )
    if (!fresh) {
      return false
    }
    this.byTerminal.set(terminal, fresh)
    return true
  }

  cancel(terminal: string): string[] {
    const requests: string[] = []
    for (const [request, stream] of this.streams) {
      if (stream.terminal !== terminal) {
        continue
      }
      if (stream.pending.size > 0) {
        this.fail(stream, { outcome: 'unknown', reason: 'cancelled' })
      }
      requests.push(request)
    }
    return requests
  }

  register(requestId: string, params: unknown, result: unknown): void {
    if (!params || typeof params !== 'object' || !result || typeof result !== 'object') {
      return
    }
    const { terminal, capabilities: offered } = params as {
      terminal?: unknown
      capabilities?: { orderedInput?: unknown }
    }
    if (offered?.orderedInput !== 1) {
      return
    }
    const { type, streamId, capabilities } = result as {
      type?: unknown
      streamId?: unknown
      capabilities?: { orderedInput?: unknown }
    }
    if (
      type !== 'subscribed' ||
      typeof terminal !== 'string' ||
      !Number.isInteger(streamId) ||
      Number(streamId) <= 0 ||
      Number(streamId) > 0xffffffff
    ) {
      return
    }
    const limits = parseLimits(capabilities?.orderedInput)
    if (!limits || this.streams.has(requestId)) {
      return
    }
    const previous = this.byTerminal.get(terminal)
    if (previous && previous.pending.size > 0) {
      this.fail(previous, { outcome: 'unknown', reason: 'subscription_replaced' })
    }
    const stream: InputStream = {
      terminal,
      streamId: Number(streamId),
      limits,
      sequence: 0,
      failed: false,
      failure: null,
      registration: ++this.registration,
      failureRegistration: 0,
      pendingBytes: 0,
      pending: new Map()
    }
    this.streams.set(requestId, stream)
    if (!this.byTerminal.get(terminal)?.failed) {
      this.byTerminal.set(terminal, stream)
    }
  }

  send(terminal: string, text: string): Promise<boolean> | null {
    const stream = this.byTerminal.get(terminal)
    if (!stream) {
      return null
    }
    if (stream.failed) {
      return Promise.resolve(false)
    }
    // Check code units before allocating a potentially oversized encoded copy.
    if (text.length === 0 || text.length > stream.limits.maxFrameBytes) {
      this.fail(stream, {
        outcome: stream.pending.size > 0 ? 'unknown' : 'rejected',
        reason: 'too_large'
      })
      return Promise.resolve(false)
    }
    const payload = new TextEncoder().encode(text)
    if (
      payload.length > stream.limits.maxFrameBytes ||
      stream.pendingBytes + payload.length > stream.limits.maxPendingBytes ||
      stream.pending.size >= stream.limits.maxPendingFrames ||
      stream.sequence >= Number.MAX_SAFE_INTEGER
    ) {
      this.fail(stream, {
        outcome: stream.pending.size > 0 ? 'unknown' : 'rejected',
        reason: 'queue_full'
      })
      return Promise.resolve(false)
    }
    const sequence = ++stream.sequence
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => this.fail(stream, { outcome: 'unknown', reason: 'receipt_timeout' }),
        30_000
      )
      stream.pending.set(sequence, { bytes: payload.length, resolve, timer })
      stream.pendingBytes += payload.length
      try {
        if (
          !this.sendBinary(
            encodeTerminalStreamFrame({
              opcode: TerminalStreamOpcode.Input,
              streamId: stream.streamId,
              seq: sequence,
              payload
            })
          )
        ) {
          this.fail(stream, { outcome: 'unknown', reason: 'connection_interrupted' })
        }
      } catch {
        this.fail(stream, { outcome: 'unknown', reason: 'connection_interrupted' })
      }
    })
  }

  handle(streamId: number, result: unknown): void {
    if (!result || typeof result !== 'object') {
      return
    }
    const metadata = result as { type?: unknown; inputReceipt?: unknown }
    const streams = [...this.streams.values()].filter((stream) => stream.streamId === streamId)
    for (const stream of streams) {
      if (metadata.type === 'error') {
        this.fail(stream)
        continue
      }
      if (metadata.type !== 'metadata' || metadata.inputReceipt === undefined) {
        continue
      }
      const receipt = metadata.inputReceipt as {
        sequence?: unknown
        outcome?: unknown
        reason?: unknown
      } | null
      if (!receipt || !Number.isSafeInteger(receipt.sequence) || Number(receipt.sequence) <= 0) {
        this.fail(stream)
        continue
      }
      const sequence = Number(receipt.sequence)
      if (sequence > stream.sequence) {
        this.fail(stream)
        continue
      }
      const pending = stream.pending.get(sequence)
      if (!pending) {
        continue
      }
      if (receipt.outcome !== 'accepted') {
        this.fail(stream, {
          outcome:
            receipt.outcome === 'rejected' && stream.pending.keys().next().value === sequence
              ? 'rejected'
              : 'unknown',
          reason: typeof receipt.reason === 'string' ? receipt.reason.slice(0, 128) : 'write_failed'
        })
        continue
      }
      clearTimeout(pending.timer)
      stream.pending.delete(sequence)
      stream.pendingBytes -= pending.bytes
      pending.resolve(true)
    }
  }

  reset(requestId: string): void {
    const stream = this.streams.get(requestId)
    if (stream) {
      const retainFailure = stream.pending.size > 0 || stream.failed
      this.fail(stream)
      if (!retainFailure && this.byTerminal.get(stream.terminal) === stream) {
        this.byTerminal.delete(stream.terminal)
      }
    }
    this.streams.delete(requestId)
  }

  clear(): void {
    for (const requestId of this.streams.keys()) {
      this.reset(requestId)
    }
  }

  private fail(
    stream: InputStream,
    failure: TerminalStreamInputFailure = {
      outcome: stream.pending.size > 0 ? 'unknown' : 'rejected',
      reason: 'stream_closed'
    }
  ): void {
    if (!stream.failed) {
      stream.failure = failure
      stream.failureRegistration = this.registration
    }
    stream.failed = true
    for (const pending of stream.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    stream.pending.clear()
    stream.pendingBytes = 0
  }
}

function parseLimits(value: unknown): Limits | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const limits = value as Limits
  if (limits.version !== 1) {
    return null
  }
  for (const key of ['maxFrameBytes', 'maxPendingBytes', 'maxPendingFrames'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      return null
    }
  }
  return {
    version: 1,
    maxFrameBytes: Math.min(limits.maxFrameBytes, TERMINAL_ORDERED_INPUT_CAPABILITY.maxFrameBytes),
    maxPendingBytes: Math.min(
      limits.maxPendingBytes,
      TERMINAL_ORDERED_INPUT_CAPABILITY.maxPendingBytes
    ),
    maxPendingFrames: Math.min(
      limits.maxPendingFrames,
      TERMINAL_ORDERED_INPUT_CAPABILITY.maxPendingFrames
    )
  }
}
