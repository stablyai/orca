import type { HeadlessEmulator } from '../../emulation/headless-emulator'
import type { TerminalCheckpointFile } from '../../protocol/daemon-checkpoint-file'
import { ColdRestoreReplayWriter, type ReplayRecordSource } from './cold-restore-replay-writer'

/** Where the replayed folder comes from besides real OSC 7 in the records. */
export type TerminalHistoryReplayCwd = {
  /** The checkpoint's folder, set after its segments so a later real OSC 7 still wins. */
  baseline?: string | null
  /** A saved probe, set before the record at this index or at the end of the records. */
  at?: { index: number; cwd: string }
}

/** Raw checkpoint segments, then applied records, through one parser so modes carry across. */
export async function replayTerminalHistory(
  emulator: HeadlessEmulator,
  checkpoint: TerminalCheckpointFile | null,
  records: ReplayRecordSource,
  isCanceled: () => boolean = () => false,
  cwd: TerminalHistoryReplayCwd = {}
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
  if (cwd.baseline) {
    emulator.setCwd(cwd.baseline)
  }
  return (await replay.replayRecords(records, isCanceled, cwd.at)) && !isCanceled()
}
