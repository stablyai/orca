/** What a move of the distro would take, before anything is journaled. */
import type {
  WslMovePreview,
  WslMoveRequest
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import { prepareWslMove, refusal, type WslMoveInterruptedSettle } from './wsl-move-driver-plan'
import {
  claimWslMoveRun,
  releaseWslMoveRun,
  wslMoveClaimRefusal
} from '../orchestration/wsl-move-running-moves'
import { unreadableSleptHistory } from '../terminal-state/wsl-move-slept-scrollback'
import { wslMoveScopeCounts } from '../manifest-scope/wsl-move-scope-counts'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../../shared/remote-runtime/remote-runtime-client-error-classification'

export const WSL_MOVE_PREVIEW_RETRY_MS = 1_500

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function previewWslMove(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest,
  /** The automatic mover's preview: settle an interrupted move first, or its fence never lifts. */
  options: { settleInterrupted?: WslMoveInterruptedSettle } = {}
): Promise<WslMovePreview> {
  if (!options.settleInterrupted) {
    return previewRetryingTransientHost(deps, request)
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

/**
 * A host still coming up (or a distro slow under load) drops its first call; the preview writes
 * nothing, so one retry after a pause beats sending the user to "Check again".
 */
async function previewRetryingTransientHost(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest
): Promise<WslMovePreview> {
  try {
    return await previewPrepared(deps, request, false)
  } catch (error) {
    if (
      !(error instanceof RemoteRuntimeClientError) ||
      !isRecoverableRemoteRuntimeConnectionError(error)
    ) {
      throw error
    }
    console.warn('[wsl-move] The host dropped the preview; retrying once:', error.code)
    await (deps.quiesce.wait ?? defaultWait)(WSL_MOVE_PREVIEW_RETRY_MS)
    return await previewPrepared(deps, request, false)
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
    mappedDrives: plan.mappedDrives ?? [],
    counts: wslMoveScopeCounts(prepared.exported),
    ...(host.browserLoginsNotCarried
      ? { browserLoginsNotCarried: host.browserLoginsNotCarried }
      : {})
  }
}
