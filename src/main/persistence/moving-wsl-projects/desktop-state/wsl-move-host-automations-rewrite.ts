/**
 * After a WSL move commits, the host turns back on the automations that were on here: the
 * manifest can only carry them disabled. Ledgered like a desktop store, so a crash or an unreachable
 * host retries on the next pass, and the move never finishes with them left off.
 */
import type { WslMoveCutover } from '../../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveUnfinished } from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  listWslMoveCutovers,
  writeWslMoveCutover
} from '../cutover-recovery/wsl-move-cutover-journal'
import {
  runWslMoveHostAutomationsTurn,
  untilWslMoveTurnAborted
} from '../cutover-recovery/wsl-move-host-automations-lock'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'

export const WSL_MOVE_HOST_AUTOMATIONS_STORE_ID = 'host-automations'

/** One moved automation as the manifest carried it; the host row keeps this `updatedAt`. */
export type WslMoveMovedAutomation = { id: string; updatedAt: number | null }

export type WslMoveHostAutomations = {
  /**
   * Idempotent; throws unless the host answered for every one. An automation the host no longer
   * has, already has on, or that changed there since the move (the user's own choice) is done.
   * Calls `onSettled` for each confirmed id so a timed-out turn resumes with only the rest.
   */
  enable: (
    environmentId: string,
    automations: readonly WslMoveMovedAutomation[],
    signal?: AbortSignal,
    onSettled?: (automationId: string) => void
  ) => Promise<void>
}

function recordReenabledAutomations(
  userDataPath: string,
  migrationId: string,
  settled: readonly string[]
): void {
  if (settled.length === 0) {
    return
  }
  try {
    const current = listWslMoveCutovers(userDataPath).find(
      (entry) => entry.migrationId === migrationId
    )
    if (!current || current.phase !== 'destination-committed') {
      return
    }
    const recorded = current.reenabledAutomationIds ?? []
    const added = [...new Set(settled)].filter((id) => !recorded.includes(id))
    if (added.length === 0) {
      return
    }
    writeWslMoveCutover(userDataPath, {
      ...current,
      reenabledAutomationIds: [...recorded, ...added],
      updatedAt: new Date().toISOString()
    })
  } catch (error) {
    console.warn('[wsl-move] Could not record confirmed host automations:', error)
  }
}

export function registerWslMoveHostAutomationsStore(
  host: WslMoveHostAutomations,
  userDataPath: string
): void {
  registerWslMoveDesktopRewriteStore({
    id: WSL_MOVE_HOST_AUTOMATIONS_STORE_ID,
    side: 'main',
    // In undo's turn, on a fresh read: a released move's copy here runs again, so its host copy stays off.
    run: ({ cutover: planned }) =>
      runWslMoveHostAutomationsTurn(async (signal) => {
        const cutover = listWslMoveCutovers(userDataPath).find(
          (entry) => entry.migrationId === planned.migrationId
        )
        const ids = cutover ? wslMoveAutomationsPending(cutover) : []
        if (!cutover || ids.length === 0) {
          return
        }
        const carried = new Map(
          (cutover.manifest.payload.dormantState?.automations ?? []).map((row) => [
            row.id,
            row.updatedAt
          ])
        )
        let active = true
        const settled: string[] = []
        // Past the deadline the step stays unledgered, but confirmed ids are saved so the next pass skips them.
        try {
          await untilWslMoveTurnAborted(
            host.enable(
              cutover.destinationEnvironmentId,
              ids.map((id) => ({ id, updatedAt: carried.get(id) ?? null })),
              signal,
              (id) => {
                if (active) {
                  settled.push(id)
                }
              }
            ),
            signal
          )
        } catch (error) {
          active = false
          recordReenabledAutomations(userDataPath, cutover.migrationId, settled)
          throw error
        }
        active = false
      }),
    // Nothing to flush here: the write is the host's.
    flush: () => {}
  })
}

/** What the host has not confirmed yet: the record's automations until its ledger entry lands. */
export function wslMoveAutomationsPending(
  cutover: Pick<
    WslMoveCutover,
    'phase' | 'rewrittenStores' | 'automationsToReenable' | 'reenabledAutomationIds'
  >
): string[] {
  const ids = cutover.automationsToReenable ?? []
  if (
    cutover.phase !== 'destination-committed' ||
    cutover.rewrittenStores.includes(WSL_MOVE_HOST_AUTOMATIONS_STORE_ID)
  ) {
    return []
  }
  const done = new Set(cutover.reenabledAutomationIds ?? [])
  return ids.filter((id) => !done.has(id))
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
