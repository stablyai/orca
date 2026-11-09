import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { commitRuntimeAttachedPtySize, type PtyGrid } from '../delivery/attached-pty-size'
import { ptySizes } from '../delivery/visibility-state'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../pane/agent-session-owners'
import { seedHeadlessTerminalFromSpawnResult } from '../pane/terminal-spawn-restore'

/** Commit the attached grid, then seed the screen a restarted runtime has never seen. */
export function seedAttachedRuntimeTerminal(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult,
  sizeBeforeAttach: PtyGrid | undefined
): void {
  const sizeNow = ptySizes.get(result.id)
  // Identity, not dimensions: A→B→A publishes a new entry that still measures A.
  const resizeLanded = sizeNow !== undefined && sizeNow !== sizeBeforeAttach
  if (!resizeLanded) {
    commitRuntimeAttachedPtySize(result, runtime?.reflowHeadlessTerminalToPtyGrid.bind(runtime))
  }
  seedHeadlessTerminalFromSpawnResult(runtime, result, null)
  seedTerminalRestoreRecordsFromSpawnResult(runtime, result)
  if (resizeLanded && sizeNow) {
    runtime?.resizeHeadlessTerminalToPtyGrid(result.id, sizeNow.cols, sizeNow.rows)
  }
}
