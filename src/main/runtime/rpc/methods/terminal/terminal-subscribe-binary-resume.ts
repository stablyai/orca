import { buildResumeGapChunk, getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import { claimTerminalStreamResume, type TerminalStreamToken } from './terminal-stream-tokens'
import type {
  TerminalSubscribeBinaryState,
  TerminalSubscribeParams,
  TerminalSubscriptionArgs
} from './terminal-subscribe-types'

/** Sends only the output this client missed in place of a snapshot; false when it must get a snapshot instead. */
export function tryPublishResumedOutput(
  args: TerminalSubscriptionArgs,
  state: TerminalSubscribeBinaryState,
  streamToken: TerminalStreamToken | null,
  resume: NonNullable<TerminalSubscribeParams['resume']>
): boolean {
  const { runtime, ptyId, emit } = args
  const size = runtime.getTerminalSize(ptyId)
  // Spend the presented token first, so even a declined resume can never be replayed.
  const gap = claimTerminalStreamResume(
    resume.streamToken,
    args.pairedDeviceId,
    ptyId,
    resume.units,
    runtime.getPtyOutputSequence(ptyId)
  )
  const ledger = streamToken?.ledger
  if (
    !gap ||
    !ledger ||
    state.pendingOutputOverflowed ||
    // A never-attached model needs the renderer mount and seed that only the snapshot path drives.
    args.missingHeadlessStateBeforeMobileFit
  ) {
    return false
  }
  state.displayMode = runtime.getMobileDisplayMode(ptyId)
  emit({
    type: 'subscribed',
    streamId: state.streamId,
    lines: [],
    truncated: false,
    cols: size?.cols,
    rows: size?.rows,
    displayMode: state.displayMode,
    seq: runtime.getLayout(ptyId)?.seq,
    outputAck: true,
    streamToken: streamToken.token,
    resumed: true
  })
  state.lastResizeCols = size?.cols
  ledger.anchor(gap.seq)
  state.buffering = false
  // Output buffered during this subscribe goes out as it would live; only older queries were answered elsewhere.
  const bufferedOutput = state.pendingOutput.splice(0)
  const firstBuffered = bufferedOutput[0]
  const bufferedStartSeq =
    typeof firstBuffered?.meta?.seq === 'number'
      ? firstBuffered.meta.seq - (firstBuffered.meta.rawLength ?? firstBuffered.data.length)
      : Number.POSITIVE_INFINITY
  const missed = buildResumeGapChunk(gap.output.filter((chunk) => chunk.seq <= bufferedStartSeq))
  if (missed) {
    state.outputBatcher.push(missed.data, missed.meta)
  }
  for (const item of bufferedOutput) {
    const uncovered = getOutputAfterSnapshotSeq(item, gap.seq)
    // An empty span still moves the seq the phone shows; it sends no frame.
    if (uncovered && (uncovered.data || uncovered.meta?.rawLength)) {
      state.outputBatcher.push(uncovered.data, uncovered.meta)
    }
  }
  state.pendingOutputBytes = 0
  state.outputBatcher.flush()
  console.log('[mobile-terminal-stream] resumed', {
    terminal: args.params.terminal,
    streamId: state.streamId,
    missedUnits: missed?.data.length ?? 0,
    bufferedChunks: bufferedOutput.length
  })
  return true
}
