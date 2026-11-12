import type { HeadlessEmulator } from '../../emulation/headless-emulator'
import type { TerminalCheckpointFile } from '../../protocol/daemon-checkpoint-file'
import { ColdRestoreReplayWriter, type ReplayRecordSource } from './cold-restore-replay-writer'

/** Raw checkpoint segments, then applied records, through one parser so modes carry across. */
export async function replayTerminalHistory(
  emulator: HeadlessEmulator,
  checkpoint: TerminalCheckpointFile | null,
  records: ReplayRecordSource,
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
  return (await replay.replayRecords(records, isCanceled)) && !isCanceled()
}
