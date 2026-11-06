import {
  mobileSnapshotByteBudget,
  sendSnapshotFrames,
  serializeBudgetedMobileSnapshot
} from './terminal-snapshot-publication'
import type {
  TerminalSubscribeBinaryState,
  TerminalSubscriptionArgs
} from './terminal-subscribe-types'

/** Sends the current screen as an in-place `resized` snapshot; resolves its output seq, or undefined when none was sent. */
export async function sendTerminalSubscribeRecoverySnapshot(
  args: TerminalSubscriptionArgs,
  state: TerminalSubscribeBinaryState,
  reason: 'pending-output-overflow' | 'output-credit-overflow'
): Promise<number | undefined> {
  const { params, runtime, ptyId } = args
  // Use the recovery's actual resized frame for its budget.
  const recoveryFrame = { kind: 'resized', reason } as const
  const recovery = await serializeBudgetedMobileSnapshot(
    runtime,
    ptyId,
    mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, recoveryFrame)
  )
  // Without output seq, retain bounded replay rather than an unverifiable renderer snapshot.
  if (state.closed || typeof recovery?.seq !== 'number') {
    return undefined
  }
  // Clients ignore repeat scrollback but apply resized inline; omit output seq to avoid polluting layout seq filtering.
  const recoveryStats = sendSnapshotFrames(state.sendFrame, {
    ...recoveryFrame,
    cols: recovery.cols,
    rows: recovery.rows,
    displayMode: state.displayMode,
    source: recovery.source,
    truncated: false,
    truncatedByByteBudget: recovery.truncatedByByteBudget,
    data: recovery.data
  })
  console.log('[mobile-terminal-stream] recovery snapshot', {
    terminal: params.terminal,
    streamId: state.streamId,
    reason,
    bytes: recoveryStats.bytes,
    chunks: recoveryStats.chunks,
    scrollbackRows: recovery.scrollbackRows,
    truncatedByByteBudget: recovery.truncatedByByteBudget === true
  })
  return recovery.seq
}

/** Credit overflow recovery: the snapshot also covers what the batcher still holds, so flush it into the held queue. */
export async function sendTerminalCreditRecoverySnapshot(
  args: TerminalSubscriptionArgs,
  state: TerminalSubscribeBinaryState
): Promise<number | undefined> {
  const snapshotSeq = await sendTerminalSubscribeRecoverySnapshot(
    args,
    state,
    'output-credit-overflow'
  )
  state.outputBatcher.flush()
  return snapshotSeq
}
