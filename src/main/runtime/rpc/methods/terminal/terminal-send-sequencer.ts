import type { OrcaRuntimeService } from '../../../orca-runtime'
import { InvalidArgumentError, type RpcContext } from '../../core'

// Why: a missing earlier send is normally a cross-socket race settled in milliseconds; a longer hold would freeze input behind a send that was never written.
export const TERMINAL_SEND_SEQUENCE_GAP_HOLD_MS = 1000
const MAX_TRACKED_STREAMS = 512

export const TERMINAL_SEND_OUT_OF_SEQUENCE = Symbol('terminal-send-out-of-sequence')

type HeldSend = {
  readonly start: () => void
  readonly cancel: () => void
}

type SequencedStream = {
  next: number
  tail: Promise<void>
  running: number
  readonly held: Map<number, HeldSend>
  gapTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Applies the sends of one stream one at a time, in sequence order. A send that arrives ahead of
 * a missing earlier one is held until that one arrives or the hold expires; a send whose turn has
 * already passed is refused, because applying it would reorder input.
 */
export class TerminalSendSequencer {
  private readonly streams = new Map<string, SequencedStream>()

  run<T>(
    streamKey: string,
    seq: number,
    signal: AbortSignal | undefined,
    apply: () => Promise<T>
  ): Promise<T | typeof TERMINAL_SEND_OUT_OF_SEQUENCE> {
    const stream = this.touchStream(streamKey)
    if (seq < stream.next || stream.held.has(seq)) {
      return Promise.resolve(TERMINAL_SEND_OUT_OF_SEQUENCE)
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        stream.held.delete(seq)
        this.settleGap(stream)
        reject(new Error('request_aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      stream.held.set(seq, {
        cancel: () => signal?.removeEventListener('abort', onAbort),
        start: () => {
          signal?.removeEventListener('abort', onAbort)
          stream.running += 1
          const applied = stream.tail.then(() => {
            if (signal?.aborted) {
              throw new Error('request_aborted')
            }
            return apply()
          })
          // Why: a refused, failed or aborted send still ends its turn; the stream never stalls on one.
          stream.tail = applied.then(
            () => undefined,
            () => undefined
          )
          void stream.tail.then(() => {
            stream.running -= 1
          })
          applied.then(resolve, reject)
        }
      })
      if (signal?.aborted) {
        onAbort()
        return
      }
      this.pump(stream)
    })
  }

  dispose(): void {
    for (const stream of this.streams.values()) {
      if (stream.gapTimer) {
        clearTimeout(stream.gapTimer)
      }
      for (const held of stream.held.values()) {
        held.cancel()
      }
    }
    this.streams.clear()
  }

  private touchStream(streamKey: string): SequencedStream {
    const existing = this.streams.get(streamKey)
    if (existing) {
      // Why: Map order is the eviction order, so reinsert on use.
      this.streams.delete(streamKey)
      this.streams.set(streamKey, existing)
      return existing
    }
    const stream: SequencedStream = {
      next: 1,
      tail: Promise.resolve(),
      running: 0,
      held: new Map(),
      gapTimer: null
    }
    this.streams.set(streamKey, stream)
    this.evictIdleStreams()
    return stream
  }

  private evictIdleStreams(): void {
    if (this.streams.size <= MAX_TRACKED_STREAMS) {
      return
    }
    for (const [key, stream] of this.streams) {
      if (stream.running === 0 && stream.held.size === 0) {
        this.streams.delete(key)
        if (this.streams.size <= MAX_TRACKED_STREAMS) {
          return
        }
      }
    }
  }

  private pump(stream: SequencedStream): void {
    let held = stream.held.get(stream.next)
    if (held && stream.gapTimer) {
      // Why: the hold measures the current gap, not one that has just closed.
      clearTimeout(stream.gapTimer)
      stream.gapTimer = null
    }
    while (held) {
      stream.held.delete(stream.next)
      stream.next += 1
      held.start()
      held = stream.held.get(stream.next)
    }
    this.settleGap(stream)
  }

  private settleGap(stream: SequencedStream): void {
    if (stream.held.size === 0) {
      if (stream.gapTimer) {
        clearTimeout(stream.gapTimer)
        stream.gapTimer = null
      }
      return
    }
    if (stream.gapTimer) {
      return
    }
    stream.gapTimer = setTimeout(() => {
      stream.gapTimer = null
      if (stream.held.size === 0) {
        return
      }
      // Why: the missing send is given up; one that turns up later is refused, not applied late.
      stream.next = Math.min(...stream.held.keys())
      this.pump(stream)
    }, TERMINAL_SEND_SEQUENCE_GAP_HOLD_MS)
    stream.gapTimer.unref?.()
  }
}

const sequencersByRuntime = new WeakMap<OrcaRuntimeService, TerminalSendSequencer>()

type SequencedTerminalSendParams = {
  readonly terminal: string
  readonly agentPrompt?: true
  readonly sequence?: { readonly stream: string; readonly seq: number }
}

type TerminalSendOutOfSequenceRefusal = {
  send: { handle: string; accepted: false; bytesWritten: 0 }
}

/** Sends without `sequence` (older clients, the CLI, the desktop) are applied as they are dispatched. */
export async function applyTerminalSendInSequence<T>(
  params: SequencedTerminalSendParams,
  context: RpcContext,
  apply: () => Promise<T>
): Promise<T | TerminalSendOutOfSequenceRefusal> {
  const { sequence } = params
  if (!sequence) {
    return apply()
  }
  if (params.agentPrompt === true) {
    // Why: a prompt submission waits on the agent for minutes and would hold every later send in its stream.
    throw new InvalidArgumentError('A sequenced terminal send cannot be an agent prompt')
  }
  let sequencer = sequencersByRuntime.get(context.runtime)
  if (!sequencer) {
    sequencer = new TerminalSendSequencer()
    sequencersByRuntime.set(context.runtime, sequencer)
  }
  // Why: stream names are chosen by the client, so scope them to the caller that sent them.
  const owner = context.clientId ?? context.connectionId ?? ''
  const streamKey = [owner, params.terminal, sequence.stream].join('\u0000')
  const result = await sequencer.run(streamKey, sequence.seq, context.signal, apply)
  if (result === TERMINAL_SEND_OUT_OF_SEQUENCE) {
    return { send: { handle: params.terminal, accepted: false, bytesWritten: 0 } }
  }
  return result
}
