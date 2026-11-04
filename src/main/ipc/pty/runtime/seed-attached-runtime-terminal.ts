import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { commitRuntimeAttachedPtySize, type PtyGrid } from '../delivery/attached-pty-size'
import { ptySizes } from '../delivery/visibility-state'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../pane/agent-session-owners'
import { seedHeadlessTerminalFromSpawnResult } from '../pane/terminal-spawn-restore'

function sameGrid(left: PtyGrid | undefined, right: PtyGrid | undefined): boolean {
  return left?.cols === right?.cols && left?.rows === right?.rows
}

/** Commit the attached grid, then seed the screen a restarted runtime has never seen. */
export function seedAttachedRuntimeTerminal(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult,
  sizeBeforeAttach: PtyGrid | undefined
): void {
  const sizeNow = ptySizes.get(result.id)
  // A resize during attach already published the live grid. Snapshot geometry is older.
  const resizeLanded = sizeNow !== undefined && !sameGrid(sizeBeforeAttach, sizeNow)
  if (!resizeLanded) {
    commitRuntimeAttachedPtySize(result, runtime?.reflowHeadlessTerminalToPtyGrid.bind(runtime))
  }
  seedHeadlessTerminalFromSpawnResult(runtime, result, null)
  seedTerminalRestoreRecordsFromSpawnResult(runtime, result)
  if (resizeLanded && sizeNow) {
    runtime?.reflowHeadlessTerminalToPtyGrid(result.id, sizeNow.cols, sizeNow.rows)
  }
}
