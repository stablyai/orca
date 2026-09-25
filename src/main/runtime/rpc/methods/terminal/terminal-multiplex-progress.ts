import {
  TerminalStreamProgress,
  terminalStreamProgressReporter
} from '../../../../observability/terminal-stream-progress'
import type { TerminalMultiplexConnectionBase } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

type MultiplexProgress = {
  progress: TerminalStreamProgress
  chunkBytes: number
  ledgerAllowed: boolean | null
  inputAwaitingClaim: number
  inputDispatchPending: number
}

const streamProgress = new WeakMap<TerminalMultiplexStream, MultiplexProgress>()

export function getTerminalMultiplexProgress(
  state: TerminalMultiplexConnectionBase,
  stream: TerminalMultiplexStream
): MultiplexProgress {
  const existing = streamProgress.get(stream)
  if (existing) {
    return existing
  }
  const entry: MultiplexProgress = {
    chunkBytes: 0,
    ledgerAllowed: null,
    inputAwaitingClaim: 0,
    inputDispatchPending: 0,
    progress: new TerminalStreamProgress(
      terminalStreamProgressReporter,
      {
        side: 'host',
        requestId: state.requestId,
        connectionId: state.connectionId,
        terminal: stream.terminal,
        streamId: stream.streamId,
        streamGeneration: stream.streamGeneration
      },
      () => ({
        chunkBytes: entry.chunkBytes,
        streamInFlightBytes: stream.ackInFlightBytes,
        streamWindowBytes: stream.ackWindowBytes,
        connectionInFlightBytes: state.ackTotalInFlightBytes,
        connectionWindowBytes: state.ackTotalWindowBytes,
        streamCreditBlocked: stream.ackInFlightBytes + entry.chunkBytes > stream.ackWindowBytes,
        connectionCreditBlocked:
          state.ackTotalInFlightBytes + entry.chunkBytes > state.ackTotalWindowBytes,
        ledgerChecked: entry.ledgerAllowed !== null,
        ledgerAllowed: entry.ledgerAllowed,
        pendingOutputBytes: stream.ackPendingOutputBytes,
        pendingOutputChunks: stream.ackPendingOutput.length,
        pendingOutputOverflowed: stream.ackPendingOutputOverflowed,
        outputPaused: stream.outputPaused,
        buffering: stream.buffering,
        recoverySnapshotInFlight: stream.ackRecoverySnapshotInFlight,
        inputAwaitingClaim: entry.inputAwaitingClaim,
        inputDispatchPending: entry.inputDispatchPending
      })
    )
  }
  streamProgress.set(stream, entry)
  return entry
}

export function recordTerminalMultiplexCredit(
  state: TerminalMultiplexConnectionBase,
  stream: TerminalMultiplexStream,
  bytes: number,
  ledgerAllowed: boolean | null,
  allowed: boolean
): void {
  const entry = getTerminalMultiplexProgress(state, stream)
  entry.chunkBytes = bytes
  entry.ledgerAllowed = ledgerAllowed
  if (!allowed) {
    entry.progress.creditBlocked()
  }
}

export function clearTerminalMultiplexCredit(stream: TerminalMultiplexStream): void {
  streamProgress.get(stream)?.progress.creditRestored()
}

export function disposeTerminalMultiplexProgress(stream: TerminalMultiplexStream): void {
  streamProgress.get(stream)?.progress.dispose()
}

export function rejectTerminalMultiplexAck(
  state: TerminalMultiplexConnectionBase,
  stream: TerminalMultiplexStream
): void {
  const { progress } = getTerminalMultiplexProgress(state, stream)
  progress.count('ackRejected')
  progress.report('ack_rejected')
}

export function cancelTerminalMultiplexCredit(stream: TerminalMultiplexStream): void {
  streamProgress.get(stream)?.progress.creditCancelled()
}
