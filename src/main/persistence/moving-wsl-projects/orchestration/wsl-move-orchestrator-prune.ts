/** Which records the orchestrator may drop: distros with neither a WSL host nor bridge projects. */
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import { recordsUserChoice } from './wsl-move-orchestrator-external-transitions'
import type { WslMoveInUseCheck } from './wsl-move-orchestrator-ports'

export type WslMovePruneContext = {
  records: ReadonlyMap<string, WslMoveOrchestratorRecord>
  isBusy: (key: string) => boolean
  isDisposed: () => boolean
  isDistroInUse: (distro: string, check: WslMoveInUseCheck) => boolean | Promise<boolean>
  drop: (key: string) => void
}

/** Drops each unused record still unchanged after its check; true when any was dropped. */
export async function pruneWslMoveOrchestratorRecords(
  context: WslMovePruneContext
): Promise<boolean> {
  const { records, isBusy, isDisposed } = context
  let changed = false
  for (const [key, record] of records) {
    if (isDisposed()) {
      return false
    }
    if (isBusy(key) || record.state.kind === 'moving' || recordsUserChoice(record)) {
      continue
    }
    // A `stateLost` hold may guard a decline the set-aside file lost: it needs stronger proof.
    const droppingLostHold = record.state.kind === 'parked' && record.state.stateLost === true
    const inUse = await context.isDistroInUse(record.distro, { droppingLostHold })
    if (isDisposed()) {
      return false
    }
    if (!inUse && records.get(key) === record && !isBusy(key)) {
      context.drop(key)
      changed = true
    }
  }
  return changed
}
