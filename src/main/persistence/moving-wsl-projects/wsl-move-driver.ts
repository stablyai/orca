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
import type {
  WslMovePreview,
  WslMoveRequest,
  WslMoveResult
} from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import {
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'
import { journalWslMove } from './wsl-move-delta-plan'
import type { WslMoveDriverDeps, WslMoveHost } from './wsl-move-driver-ports'
import {
  exportRequestOf,
  isWslMoveScopeChanged,
  manifestTooLargeRefusal,
  prepareWslMove,
  refusal,
  type WslMovePrepared
} from './wsl-move-driver-plan'
import {
  collectWslMoveBlobs,
  commitWslMove,
  sendWslMoveBlobs,
  stageWslMove
} from './wsl-move-driver-transfer'
import { pauseWslMoveScope } from './wsl-move-driver-pause'
import { quiesceWslMove, type WslMoveQuiesceRefusalReason } from './wsl-move-quiesce'
import { wslMoveAutomationsPending } from './wsl-move-host-automations-rewrite'
import { resetWslMoveToZero } from './wsl-move-reset'

class WslMoveStop extends Error {}

type RunningMove = { controller: AbortController; commitRequested: boolean }

// One run per distro in this process; the journal's compare-and-swap orders it against others.
const runningMoves = new Map<string, RunningMove>()

export async function previewWslMove(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest
): Promise<WslMovePreview> {
  const prepared = await prepareWslMove(deps, request, deps.newMigrationId(), deps.now())
  if ('outcome' in prepared) {
    return prepared
  }
  const { plan } = prepared
  return {
    outcome: 'ready',
    distro: plan.distro,
    repoIds: plan.repoIds,
    folderWorkspaceIds: plan.folderWorkspaceIds,
    changed: plan.changed,
    heldByHost: plan.heldByHost,
    refused: plan.refused,
    blockers: prepared.blockers
  }
}

/** Cancels a run that has not asked the host to commit yet; true when one was running. */
export function cancelWslMove(distro: string): boolean {
  const running = runningMoves.get(wslMoveJournalKey(distro))
  if (!running || running.commitRequested) {
    return false
  }
  running.controller.abort()
  return true
}

export async function moveProjectsToWslHost(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest
): Promise<WslMoveResult> {
  const key = wslMoveJournalKey(request.distro)
  if (runningMoves.has(key)) {
    return refusal('wsl_move_already_running')
  }
  const running: RunningMove = { controller: new AbortController(), commitRequested: false }
  runningMoves.set(key, running)
  const migrationId = deps.newMigrationId()
  try {
    return await runMove(deps, request, migrationId, running)
  } catch (error) {
    // Anything unforeseen: back to zero without the host, which never resets a possible commit.
    return putBack(deps, null, migrationId, describe(error))
  } finally {
    runningMoves.delete(key)
  }
}

async function runMove(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest,
  migrationId: string,
  running: RunningMove
): Promise<WslMoveResult> {
  const { signal } = running.controller
  const { distro } = request
  deps.progress({ distro, step: 'preparing' })
  const startedAt = deps.now()
  const prepared = await prepareWslMove(deps, request, migrationId, startedAt, true)
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
  const paused = await pauseWslMoveScope(deps, scope)
  if ('outcome' in paused) {
    return paused
  }
  const { panes } = paused
  let journaled: WslMoveCutover
  try {
    // The slept state, which the session freeze then holds for the rest of the move.
    const exported = deps.exportManifest(exportRequestOf(prepared, migrationId, startedAt))
    if (exported.blockers.length > 0) {
      return refusal('wsl_move_export_incomplete', { reasons: [...exported.blockers] })
    }
    journaled = journalWslMove({
      userDataPath: deps.userDataPath,
      plan: prepared.plan,
      manifest: exported.manifest,
      destinationName: host.name,
      automationsToReenable: exported.automationsToReenable,
      now: () => startedAt
    })
  } catch (error) {
    const tooLarge = manifestTooLargeRefusal(error)
    if (tooLarge) {
      return tooLarge
    }
    if (describe(error) === 'wsl_move_already_in_flight') {
      return refusal('wsl_move_already_in_flight')
    }
    if (isWslMoveScopeChanged(error)) {
      return refusal('wsl_move_scope_changed')
    }
    throw error
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
      : refusal('wsl_move_pause_failed', { detail: pauseDetail(quiesced.reason, quiesced.detail) })
  }
  try {
    return await moveQuiesced(deps, host, quiesced.cutover, prepared, running)
  } catch (error) {
    return putBack(deps, host, migrationId, describe(error))
  }
}

async function moveQuiesced(
  deps: WslMoveDriverDeps,
  host: WslMoveHost,
  quiesced: WslMoveCutover,
  prepared: WslMovePrepared,
  running: RunningMove
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
    again = deps.exportManifest(exportRequestOf(prepared, migrationId, startedAt))
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
  const blobs = await collectWslMoveBlobs(deps, quiesced, again.worktrees)
  const bytesTotal = blobs.descriptors.reduce((sum, blob) => sum + blob.byteLength, 0)
  deps.progress({ distro, step: 'copying', migrationId, phase: staged.phase, bytesTotal })
  const transferred = await sendWslMoveBlobs(deps, host, staged, blobs)
  deps.progress({
    distro,
    step: 'copying',
    migrationId,
    phase: transferred.phase,
    bytesSent: bytesTotal,
    bytesTotal
  })
  stopIfCancelled()
  // From here a cancel can no longer be honoured: the host may commit whatever this run sees.
  running.commitRequested = true
  deps.progress({ distro, step: 'switching', migrationId, phase: transferred.phase })
  const committed = await commitWslMove(deps, host, transferred, blobs.descriptors)
  return finish(deps, distro, committed.migrationId)
}

async function finish(
  deps: WslMoveDriverDeps,
  distro: string,
  migrationId: string
): Promise<WslMoveResult> {
  deps.progress({ distro, step: 'finishing', migrationId, phase: 'destination-committed' })
  // Forward only from here: a failed rewrite resumes on the next pass or startup, never resets.
  await deps.finishOnDesktop().catch((error: unknown) => {
    console.warn('[wsl-move] Finishing the move on this desktop paused:', error)
  })
  const cutover = listWslMoveCutovers(deps.userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  const phase = cutover?.phase ?? 'destination-committed'
  // Never silently off: the result names them, and the rewrite pass keeps retrying them.
  const automationsPending = cutover ? wslMoveAutomationsPending(cutover) : []
  deps.progress({ distro, step: 'done', migrationId, phase })
  return {
    outcome: 'moved',
    migrationId,
    phase,
    reloadRequired: true,
    ...(automationsPending.length > 0 ? { automationsPending } : {})
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
  return { outcome: 'reset', migrationId, detail }
}

function pauseDetail(reason: WslMoveQuiesceRefusalReason, detail: string | undefined): string {
  return detail ? `${reason}: ${detail}` : reason
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
