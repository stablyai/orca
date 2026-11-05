/** Advance journal phases in order, starting after any persisted phase. */
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutover
} from '../../../../shared/wsl-move/wsl-move-cutover'
import {
  listWslMoveCutovers,
  writeWslMoveCutover
} from '../../moving-wsl-projects/wsl-move-cutover-journal'
import { setWslMoveDesktopRewriteRegistryCompleteForTests } from '../../moving-wsl-projects/wsl-move-desktop-rewrite-stores'

export function seedWslMoveCutover(userDataPath: string, cutover: WslMoveCutover): void {
  const existing = listWslMoveCutovers(userDataPath).find(
    (entry) => entry.migrationId === cutover.migrationId
  )
  const from = existing ? WSL_MOVE_CUTOVER_PHASES.indexOf(existing.phase) + 1 : 0
  const to = WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase)
  const rewriteFrom = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')
  // Preserve the existing rewrite ledger when none is supplied.
  const ledger =
    cutover.rewrittenStores.length > 0 ? cutover.rewrittenStores : (existing?.rewrittenStores ?? [])
  const previous = setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  try {
    for (const phase of WSL_MOVE_CUTOVER_PHASES.slice(from, to + 1)) {
      const index = WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
      // Rewrites become visible only after the destination-committed phase.
      writeWslMoveCutover(userDataPath, {
        ...cutover,
        phase,
        rewrittenStores: index <= rewriteFrom ? [] : ledger
      })
      if (index === rewriteFrom) {
        writeWslMoveCutover(userDataPath, { ...cutover, phase, rewrittenStores: ledger })
      }
    }
  } finally {
    setWslMoveDesktopRewriteRegistryCompleteForTests(previous)
  }
}
