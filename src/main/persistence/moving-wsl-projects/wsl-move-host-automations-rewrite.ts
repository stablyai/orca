/**
 * After a WSL move commits, the host turns back on the automations that were on here: the
 * manifest can only carry them disabled. Ledgered like a desktop store, so a crash or an unreachable
 * host retries on the next pass, and the move never finishes with them left off.
 */
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveUnfinished } from '../../../shared/wsl-move/wsl-move-driver-types'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'

export const WSL_MOVE_HOST_AUTOMATIONS_STORE_ID = 'host-automations'

/** One moved automation as the manifest carried it; the host row keeps this `updatedAt`. */
export type WslMoveMovedAutomation = { id: string; updatedAt: number | null }

export type WslMoveHostAutomations = {
  /**
   * Idempotent; throws unless the host answered for every one. An automation the host no longer
   * has, already has on, or that changed there since the move (the user's own choice) is done.
   */
  enable: (environmentId: string, automations: readonly WslMoveMovedAutomation[]) => Promise<void>
}

export function registerWslMoveHostAutomationsStore(host: WslMoveHostAutomations): void {
  registerWslMoveDesktopRewriteStore({
    id: WSL_MOVE_HOST_AUTOMATIONS_STORE_ID,
    side: 'main',
    run: async ({ cutover }) => {
      const ids = cutover.automationsToReenable ?? []
      if (ids.length === 0) {
        return
      }
      const carried = new Map(
        (cutover.manifest.payload.dormantState?.automations ?? []).map((row) => [
          row.id,
          row.updatedAt
        ])
      )
      await host.enable(
        cutover.destinationEnvironmentId,
        ids.map((id) => ({ id, updatedAt: carried.get(id) ?? null }))
      )
    },
    // Nothing to flush here: the write is the host's.
    flush: () => {}
  })
}

/** What the host has not confirmed yet: the record's automations until its ledger entry lands. */
export function wslMoveAutomationsPending(
  cutover: Pick<WslMoveCutover, 'phase' | 'rewrittenStores' | 'automationsToReenable'>
): string[] {
  const ids = cutover.automationsToReenable ?? []
  return cutover.phase === 'destination-committed' &&
    !cutover.rewrittenStores.includes(WSL_MOVE_HOST_AUTOMATIONS_STORE_ID)
    ? [...ids]
    : []
}

/** Committed moves whose host steps are not all confirmed, for the notice the UI shows. */
export function listUnfinishedWslMoves(userDataPath: string): WslMoveUnfinished[] {
  return listWslMoveCutovers(userDataPath).flatMap((cutover) => {
    // Plus what a refused undo turned off on the host and could not turn back on yet.
    const automationsPending = [
      ...new Set([...wslMoveAutomationsPending(cutover), ...(cutover.hostAutomationsLeftOff ?? [])])
    ]
    return automationsPending.length > 0
      ? [
          {
            migrationId: cutover.migrationId,
            distro: cutover.manifest.source.distro,
            automationsPending
          }
        ]
      : []
  })
}
