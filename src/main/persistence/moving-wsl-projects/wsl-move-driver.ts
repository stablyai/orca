/**
 * The move driver: one "move projects to the WSL host" run, end to end (mover design, 3.3 and 4.4).
 *
 * Plan and gate, then Sleep the scope, export the slept state and journal it (`prepared`), fence
 * and prove every terminal exited (`quiesced`, with the restore hints), re-export to prove nothing
 * changed under the fence, then stage, send, and commit only from `blobs-transferred`. Any failure
 * resets to zero through #29825's `resetWslMoveToZero`, which also carries a commit that landed
 * forward. After commit the desktop rewrite runs; retention follows on the journal change.
 *
 * Sleep runs before the export because the journal binds the manifest at `prepared` and never
 * rebinds it: a manifest taken before Sleep would carry scrollback Sleep then rewrites.
 */
import type { WslMoveRequest, WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { removeWslMoveCutover, writeWslMoveCutover } from './wsl-move-cutover-journal'
import { journalSleptWslMove } from './wsl-move-driver-journal'
import type { WslMoveDriverDeps, WslMoveHost } from './wsl-move-driver-ports'
import {
  readSleptScrollback,
  daemonHistoryLeafOf,
  type WslMoveSleptScrollback
} from './wsl-move-slept-scrollback'
import { reportWslMoveRunEnd } from './wsl-move-driver-run-end'
import {
  exportRequestOf,
  isWslMoveScopeChanged,
  prepareWslMove,
  refusal,
  type WslMovePrepared
} from './wsl-move-driver-plan'
import {
  advanceWslMove,
  collectWslMoveBlobs,
  commitWslMove,
  sendWslMoveBlobs,
  stageWslMove,
  wslMoveCopyBytes
} from './wsl-move-driver-transfer'
import { pauseWslMoveScope } from './wsl-move-driver-pause'
import { quiesceWslMove, type WslMoveQuiesceRefusalReason } from './wsl-move-quiesce'
import { finishWslMove as finish } from './wsl-move-driver-finish'
import { resetWslMoveToZero } from './wsl-move-reset'
import {
  claimWslMoveRun,
  releaseWslMoveRun,
  wslMoveClaimRefusal,
  type RunningWslMove
} from './wsl-move-running-moves'
import {
  holdWslMoveWindowWritesForCommit,
  settleWslMoveWindowWriteHoldForCommit
} from './wsl-move-window-write-hold'

class WslMoveStop extends Error {}

/** A terminal started in scope after the quiesce proved every one exited. */
const WSL_MOVE_TERMINALS_STARTED = 'terminals-started-after-pause'
/** The quiesce's own wording, so both proofs read alike in the result. */
const WSL_MOVE_EXIT_UNVERIFIABLE = 'exit-unverifiable'

export { cancelWslMove, isWslMoveRunning } from './wsl-move-running-moves'
export { previewWslMove } from './wsl-move-driver-preview'

export async function moveProjectsToWslHost(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest
): Promise<WslMoveResult> {
  const running = claimWslMoveRun(request.distro)
  if (!running) {
    return refusal(wslMoveClaimRefusal(request.distro))
  }
  const migrationId = deps.newMigrationId()
  running.migrationId = migrationId
  // Anything unforeseen: back to zero without the host, which never resets a possible commit.
  return reportWslMoveRunEnd(deps, request.distro, (tracked) =>
    runMove(tracked, request, migrationId, running)
      .catch((error: unknown) => putBack(tracked, null, migrationId, describe(error)))
      .finally(() => {
        releaseWslMoveRun(request.distro, running)
        // Committed runs settled it in `finish`; any other end leaves the window as it was.
        settleWslMoveWindowWriteHoldForCommit(false)
      })
  )
}

async function runMove(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest,
  migrationId: string,
  running: RunningWslMove
): Promise<WslMoveResult> {
  const { signal } = running.controller
  const { distro } = request
  deps.progress({ distro, step: 'preparing' })
  const startedAt = deps.now()
  const prepared = await prepareWslMove(deps, request, migrationId, startedAt, 'finish-now')
  if ('outcome' in prepared) {
    return prepared
  }
  if (prepared.blockers.length > 0) {
    return refusal('wsl_move_terminals_blocked', { blockers: prepared.blockers })
  }
  if (signal.aborted) {
    return refusal('wsl_move_cancelled')
  }
  const { host, scope } = prepared
  deps.progress({ distro, step: 'pausing-terminals', migrationId })
  const paused = await pauseWslMoveScope(deps, scope, request.sleptPanes)
  if ('outcome' in paused) {
    return paused
  }
  const { panes } = paused
  const slept = await readSleptScrollback(
    deps,
    panes,
    distro,
    migrationId,
    scope.workspaceIds,
    request.sleptPanes
  )
  try {
    const journaled = await journalSleptWslMove(deps, prepared, migrationId, startedAt, slept)
    if ('outcome' in journaled) {
      return journaled
    }
    const quiesced = await quiesceWslMove(
      journaled,
      { workspaceIds: scope.workspaceIds, workspaceKeys: scope.workspaceKeys, panes },
      {
        ...deps.quiesce,
        gateInputs: () => deps.gateInputs(scope),
        writeCutover: (cutover) => writeWslMoveCutover(deps.userDataPath, cutover),
        removeCutover: (id) => removeWslMoveCutover(deps.userDataPath, id),
        now: deps.now
      }
    )
    if (quiesced.outcome === 'refused') {
      // A refusal before the fence leaves the `prepared` record; nothing reached the host.
      await resetWslMoveToZero(
        { userDataPath: deps.userDataPath, destination: null },
        migrationId
      ).catch(() => {})
      if (!quiesced.fenceLifted) {
        return putBack(deps, host, migrationId, `pause:${quiesced.reason}`)
      }
      return quiesced.reason === 'terminals-blocked'
        ? refusal('wsl_move_terminals_blocked', { blockers: quiesced.blockers ?? [] })
        : refusal('wsl_move_pause_failed', {
            detail: pauseDetail(quiesced.reason, quiesced.detail)
          })
    }
    try {
      return await moveQuiesced(deps, host, quiesced.cutover, prepared, running, slept)
    } catch (error) {
      return putBack(deps, host, migrationId, describe(error))
    }
  } finally {
    slept.dispose()
  }
}

async function moveQuiesced(
  deps: WslMoveDriverDeps,
  host: WslMoveHost,
  quiesced: WslMoveCutover,
  prepared: WslMovePrepared,
  running: RunningWslMove,
  slept: WslMoveSleptScrollback
): Promise<WslMoveResult> {
  const { signal } = running.controller
  const { distro } = prepared.plan
  const { migrationId } = quiesced
  const stopIfCancelled = (): void => {
    if (signal.aborted) {
      throw new WslMoveStop('wsl_move_cancelled')
    }
  }
  // Under the fence: the same export must still come out, or something in scope changed.
  const startedAt = new Date(quiesced.startedAt)
  let again: ReturnType<WslMoveDriverDeps['exportManifest']>
  try {
    again = deps.exportManifest(
      exportRequestOf(prepared, migrationId, startedAt, daemonHistoryLeafOf(slept))
    )
  } catch (error) {
    throw isWslMoveScopeChanged(error) ? new WslMoveStop('wsl_move_scope_changed') : error
  }
  // State the payload leaves out (left-behind items, automations on here) is outside the digest.
  if (
    again.manifest.manifestSha256 !== quiesced.manifestSha256 ||
    again.blockers.length > 0 ||
    JSON.stringify(again.automationsToReenable) !==
      JSON.stringify(quiesced.automationsToReenable ?? [])
  ) {
    throw new WslMoveStop('wsl_move_scope_changed')
  }
  stopIfCancelled()
  deps.progress({ distro, step: 'copying', migrationId, phase: quiesced.phase })
  const staged = await stageWslMove(deps, host, quiesced)
  stopIfCancelled()
  const blobs = await collectWslMoveBlobs(deps, quiesced, again.worktrees, slept)
  const { snapshotBytes, bytesTotal } = wslMoveCopyBytes(quiesced, blobs.descriptors)
  deps.progress({
    distro,
    step: 'copying',
    migrationId,
    phase: staged.phase,
    bytesSent: snapshotBytes,
    bytesTotal
  })
  await sendWslMoveBlobs(host, staged, blobs)
  // Still short of `blobs-transferred`: no commit can exist yet, so a refusal here always resets.
  await proveStillExited(deps, quiesced, prepared)
  stopIfCancelled()
  const transferred = advanceWslMove(deps, staged, 'blobs-transferred')
  deps.progress({
    distro,
    step: 'copying',
    migrationId,
    phase: transferred.phase,
    bytesSent: bytesTotal,
    bytesTotal
  })
  // From here a cancel can no longer be honoured: the host may commit whatever this run sees.
  running.commitRequested = true
  // The host publishes the moved projects at commit; an open window must not save its view of them.
  holdWslMoveWindowWritesForCommit()
  deps.progress({ distro, step: 'switching', migrationId, phase: transferred.phase })
  const committed = await commitWslMove(deps, host, transferred, blobs.descriptors)
  return finish(deps, distro, committed.migrationId)
}

/**
 * The quiesce proved exit once; a terminal in scope that started since would outlive the commit in
 * a moved folder. Nothing awaits between this census and the commit request.
 */
async function proveStillExited(
  deps: WslMoveDriverDeps,
  quiesced: WslMoveCutover,
  prepared: WslMovePrepared
): Promise<void> {
  const proof = await deps.quiesce.proveExited({
    distro: quiesced.manifest.source.distro,
    workspaceKeys: prepared.scope.workspaceKeys,
    sessionIds: new Set(quiesced.provenExitedSessionIds)
  })
  if (proof.verdict === 'live') {
    throw new WslMoveStop(WSL_MOVE_TERMINALS_STARTED)
  }
  if (proof.verdict === 'unverifiable') {
    throw new WslMoveStop(`${WSL_MOVE_EXIT_UNVERIFIABLE}: ${proof.reason}`)
  }
}

/** Back to zero, or forward when the host proves it committed; never a guess. */
async function putBack(
  deps: WslMoveDriverDeps,
  host: WslMoveHost | null,
  migrationId: string,
  detail: string
): Promise<WslMoveResult> {
  let reset: Awaited<ReturnType<typeof resetWslMoveToZero>>
  try {
    reset = await resetWslMoveToZero(
      { userDataPath: deps.userDataPath, destination: host?.catalog ?? null, now: deps.now },
      migrationId
    )
  } catch (error) {
    return { outcome: 'waiting-for-host', migrationId, detail: `${detail}; ${describe(error)}` }
  }
  if (reset.outcome === 'committed') {
    return finish(deps, reset.cutover.manifest.source.distro, migrationId)
  }
  if (reset.outcome === 'unverifiable') {
    return { outcome: 'waiting-for-host', migrationId, detail: `${detail}; ${reset.reason}` }
  }
  if (detail === 'wsl_move_cancelled' || detail === 'wsl_move_scope_changed') {
    return refusal(detail)
  }
  if (
    detail === WSL_MOVE_TERMINALS_STARTED ||
    detail.startsWith(`${WSL_MOVE_EXIT_UNVERIFIABLE}: `)
  ) {
    return refusal('wsl_move_pause_failed', { detail })
  }
  return { outcome: 'reset', migrationId, detail }
}

function pauseDetail(reason: WslMoveQuiesceRefusalReason, detail: string | undefined): string {
  return detail ? `${reason}: ${detail}` : reason
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
