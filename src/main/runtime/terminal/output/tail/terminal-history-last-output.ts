import { getDaemonHistoryDir } from '../../../../daemon/launch/daemon-launch-paths'
import { HistoryReader } from '../../../../daemon/history/restoration/history-reader'
import { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'
import { terminalLastOutput } from './terminal-tail-read'

/** A terminal's last lines from the history its daemon saved, for one whose process is gone with its record. */
export async function terminalHistoryLastOutput(sessionId: string): Promise<string | undefined> {
  try {
    const restored = await new HistoryReader(getDaemonHistoryDir()).detectColdRestore(sessionId, {
      ignoreCleanEnd: true
    })
    const seed = restored ? buildRestoredTerminalTailSeed(restored.snapshotAnsi) : null
    return terminalLastOutput(
      seed ? { tailBuffer: seed.lines, tailPartialLine: seed.partialLine } : undefined
    )
  } catch {
    return undefined
  }
}
