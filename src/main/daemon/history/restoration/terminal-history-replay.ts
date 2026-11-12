import type { HeadlessEmulator } from '../../emulation/headless-emulator'
import type { TerminalCheckpointFile } from '../../protocol/daemon-checkpoint-file'
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'

/** Raw checkpoint segments, then applied records, through one parser so modes carry across. */
export async function replayTerminalHistory(
  emulator: HeadlessEmulator,
  checkpoint: TerminalCheckpointFile | null,
  records: Iterable<PendingOutputRecord>,
  isCanceled: () => boolean = () => false
): Promise<boolean> {
  const replay = new ColdRestoreReplayWriter(emulator)
  if (checkpoint) {
    if (
      !(await replay.write(checkpoint.scrollbackAnsi ?? '')) ||
      !(await replay.write(checkpoint.rehydrateSequences)) ||
      !(await replay.write(checkpoint.snapshotAnsi)) ||
      !(await replay.write(checkpoint.pendingEscapeTailAnsi ?? ''))
    ) {
      return false
    }
    emulator.setRestoredOscLinks(checkpoint.oscLinks)
    if (checkpoint.lastTitle) {
      emulator.setLastTitle(checkpoint.lastTitle)
    }
  }
  for (const record of records) {
    if (isCanceled()) {
      return false
    }
    if (record.kind === 'output') {
      if (!(await replay.write(record.data))) {
        return false
      }
    } else if (record.kind === 'resize') {
      if (!isValidTerminalHistorySize(record.cols, record.rows)) {
        return false
      }
      await replay.resize(record.cols, record.rows)
    } else {
      await replay.clearScrollback()
    }
  }
  return !isCanceled()
}
