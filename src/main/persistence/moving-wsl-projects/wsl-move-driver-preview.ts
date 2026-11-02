/** What a move of the distro would take, before anything is journaled. */
import type { WslMovePreview, WslMoveRequest } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import { prepareWslMove, refusal, type WslMoveInterruptedSettle } from './wsl-move-driver-plan'
import { claimWslMoveRun, releaseWslMoveRun, wslMoveClaimRefusal } from './wsl-move-running-moves'
import { unreadableSleptHistory } from './wsl-move-slept-scrollback'

export async function previewWslMove(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest,
  /** The automatic mover's preview: settle an interrupted move first, or its fence never lifts. */
  options: { settleInterrupted?: WslMoveInterruptedSettle } = {}
): Promise<WslMovePreview> {
  if (!options.settleInterrupted) {
    return previewPrepared(deps, request, false)
  }
  // Settling writes the journal and asks the host, so it holds the distro's run like a move.
  const running = claimWslMoveRun(request.distro)
  if (!running) {
    return refusal(wslMoveClaimRefusal(request.distro))
  }
  try {
    return await previewPrepared(deps, request, options.settleInterrupted)
  } finally {
    releaseWslMoveRun(request.distro, running)
  }
}

async function previewPrepared(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest,
  settleInterrupted: WslMoveInterruptedSettle | false
): Promise<WslMovePreview> {
  const migrationId = deps.newMigrationId()
  const prepared = await prepareWslMove(deps, request, migrationId, deps.now(), settleInterrupted)
  if ('outcome' in prepared) {
    return prepared
  }
  const unreadable = await unreadableSleptHistory(
    deps,
    request,
    migrationId,
    prepared.scope.workspaceIds
  )
  if (unreadable.length > 0) {
    return refusal('wsl_move_export_incomplete', { reasons: unreadable })
  }
  const { plan, host } = prepared
  return {
    outcome: 'ready',
    distro: plan.distro,
    repoIds: plan.repoIds,
    folderWorkspaceIds: plan.folderWorkspaceIds,
    changed: plan.changed,
    heldByHost: plan.heldByHost,
    refused: plan.refused,
    blockers: prepared.blockers,
    ...(host.browserLoginsNotCarried
      ? { browserLoginsNotCarried: host.browserLoginsNotCarried }
      : {})
  }
}
