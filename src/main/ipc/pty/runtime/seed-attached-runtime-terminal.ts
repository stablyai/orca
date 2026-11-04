import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { commitRuntimeAttachedPtySize } from '../delivery/attached-pty-size'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../pane/agent-session-owners'
import { seedHeadlessTerminalFromSpawnResult } from '../pane/terminal-spawn-restore'

/** Commit the attached grid, then seed the screen a restarted runtime has never seen. */
export function seedAttachedRuntimeTerminal(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult
): void {
  commitRuntimeAttachedPtySize(result, runtime?.reflowHeadlessTerminalToPtyGrid.bind(runtime))
  // A restarted runtime has never seen this screen; an idle agent may print nothing after attach.
  seedHeadlessTerminalFromSpawnResult(runtime, result, null)
  seedTerminalRestoreRecordsFromSpawnResult(runtime, result)
}
