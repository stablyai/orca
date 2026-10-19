/**
 * Writes a move's record through every phase up to its own, as the journal requires, starting
 * after the phase already on disk so a test can also advance an existing move.
 */
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
  // The ledger never shrinks: an unstated one keeps what the record already holds.
  const ledger =
    cutover.rewrittenStores.length > 0 ? cutover.rewrittenStores : (existing?.rewrittenStores ?? [])
  // Seeding stands in for a finished rewrite, whatever stores exist yet.
  const previous = setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  try {
    for (const phase of WSL_MOVE_CUTOVER_PHASES.slice(from, to + 1)) {
      const index = WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
      // The ledger only grows inside the rewrite phase, so earlier phases carry none of it.
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
