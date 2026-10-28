/**
 * Before anything is paused or fenced: the host, the plan (a full or delta move), the export and
 * the terminal gate. The preview shows exactly this; the move re-runs it and starts only if it
 * still passes.
 */
import type { WslMoveRefusal, WslMoveRequest } from '../../../shared/wsl-move/wsl-move-driver-types'
import {
  WSL_MOVE_CUTOVER_PHASES,
  wslMoveJournalKey
} from '../../../shared/wsl-move/wsl-move-cutover'
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import { listWslMoveCutoverChain } from './wsl-move-cutover-journal'
import type { WslMovePlan } from './wsl-move-delta-plan'
import { planWslMove } from './wsl-move-delta-plan'
import type {
  WslMoveDriverDeps,
  WslMoveHost,
  WslMoveManifestExport,
  WslMoveManifestExportRequest,
  WslMoveTerminalScope
} from './wsl-move-driver-ports'
import { assertWslMoveManifestFits } from './wsl-move-manifest-budget'
import { WslMoveScopeChangedError } from './wsl-move-manifest-export'
import { wslMoveHostReadiness } from './wsl-move-preflight'
import { settleWslMoveOwedHostAborts } from './wsl-move-owed-host-aborts'
import { resetWslMoveToZero } from './wsl-move-reset'
import { assessWslMoveTerminals, type WslMoveGateBlocker } from './wsl-move-terminal-gate'

export const WSL_MOVE_MANIFEST_TOO_LARGE_PREFIX = 'wsl_move_manifest_too_large:'
// Thrown by manifest parsing past the absolute cap, before the journal's own budget can explain.
const MANIFEST_OVER_CAP = 'orcad_migration_manifest_too_large'
const MANIFEST_OVER_CAP_MESSAGE =
  'The saved state of these projects is too large to move in one step. Move fewer projects at a time, or close unused tabs and clear old terminal history first.'

export type WslMovePrepared = {
  host: WslMoveHost
  plan: WslMovePlan
  exported: WslMoveManifestExport
  scope: WslMoveTerminalScope
  blockers: WslMoveGateBlocker[]
}

export function refusal(
  code: WslMoveRefusal['code'],
  extra: Omit<WslMoveRefusal, 'outcome' | 'code'> = {}
): WslMoveRefusal {
  return { outcome: 'refused', code, ...extra }
}

/** The exporter's "a planned row is gone": the plan is stale, so the user plans again. */
export function isWslMoveScopeChanged(error: unknown): boolean {
  return error instanceof WslMoveScopeChangedError
}

/** The too-large refusal carries its user-facing message after the code. */
export function manifestTooLargeRefusal(error: unknown): WslMoveRefusal | null {
  const message = error instanceof Error ? error.message : ''
  if (message === MANIFEST_OVER_CAP) {
    return refusal('wsl_move_manifest_too_large', { message: MANIFEST_OVER_CAP_MESSAGE })
  }
  return message.startsWith(WSL_MOVE_MANIFEST_TOO_LARGE_PREFIX)
    ? refusal('wsl_move_manifest_too_large', {
        message: message.slice(WSL_MOVE_MANIFEST_TOO_LARGE_PREFIX.length)
      })
    : null
}

/**
 * A move a crash or a lost host left short of commit (e.g. `blobs-transferred` with no host to
 * ask at startup) keeps its projects fenced. With the host connected now, #29825's reset decides
 * it: back to zero, or forward to the rewrite when the host committed. Only an answer it cannot
 * get keeps the fence, and the new move waits.
 */
async function settleInterruptedWslMove(
  deps: WslMoveDriverDeps,
  host: WslMoveHost,
  request: WslMoveRequest
): Promise<WslMoveRefusal | null> {
  const journalKey = wslMoveJournalKey(request.distro)
  // Before this move stages: a leftover stage of an earlier reset would refuse it.
  await settleWslMoveOwedHostAborts(deps.userDataPath, journalKey, host.catalog)
  const head = listWslMoveCutoverChain(deps.userDataPath, journalKey).at(-1)
  if (
    !head ||
    WSL_MOVE_CUTOVER_PHASES.indexOf(head.phase) >=
      WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')
  ) {
    return null
  }
  const reset = await resetWslMoveToZero(
    { userDataPath: deps.userDataPath, destination: host.catalog, now: deps.now },
    head.migrationId
  )
  if (reset.outcome === 'unverifiable') {
    return refusal('wsl_move_already_in_flight', { detail: reset.reason })
  }
  if (reset.outcome === 'committed') {
    await deps.finishOnDesktop().catch((error: unknown) => {
      console.warn('[wsl-move] Finishing an interrupted move on this desktop paused:', error)
    })
    // The window must reload before another move starts under it.
    return refusal('wsl_move_finished_earlier_move')
  }
  return null
}

/**
 * A move left waiting on a host whose distro is now unregistered can never hear back: the commit,
 * if any, went with the distro's disk. Back to zero, so the projects are usable here again.
 */
async function resetForUnregisteredDistro(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest
): Promise<boolean> {
  const head = listWslMoveCutoverChain(deps.userDataPath, wslMoveJournalKey(request.distro)).at(-1)
  if (
    !head ||
    WSL_MOVE_CUTOVER_PHASES.indexOf(head.phase) >=
      WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed') ||
    (await deps
      .isDistroRegistered(request.distro, head.manifest.source.distroGuid)
      .catch(() => null)) !== false
  ) {
    return false
  }
  const reset = await resetWslMoveToZero(
    {
      userDataPath: deps.userDataPath,
      destination: null,
      destinationUnregistered: true,
      now: deps.now
    },
    head.migrationId
  )
  return reset.outcome === 'reset'
}

/** Fixed id and clock, so a re-export of unchanged state signs the same digest. */
export function exportRequestOf(
  prepared: Pick<WslMovePrepared, 'plan' | 'host'>,
  migrationId: string,
  startedAt: Date,
  daemonHistoryLeaf?: (tabId: string, leafId: string) => boolean
): WslMoveManifestExportRequest {
  const { plan, host } = prepared
  return {
    ...(daemonHistoryLeaf ? { daemonHistoryLeaf } : {}),
    migrationId,
    now: () => startedAt,
    distro: plan.distro,
    ...(host.distroGuid ? { distroGuid: host.distroGuid } : {}),
    destinationEnvironmentId: host.environmentId,
    generation: plan.generation,
    repoIds: plan.repoIds,
    folderWorkspaceIds: plan.folderWorkspaceIds
  }
}

export async function prepareWslMove(
  deps: WslMoveDriverDeps,
  request: WslMoveRequest,
  migrationId: string,
  startedAt: Date,
  /** Move only: settle an earlier move of the distro an interruption left short of commit. */
  settleInterrupted = false
): Promise<WslMovePrepared | WslMoveRefusal> {
  if (!wslHostsGateOpen()) {
    return refusal('wsl_move_unavailable')
  }
  let host: WslMoveHost | null
  try {
    host = await deps.connectHost(request.distro)
  } catch (error) {
    // A kept host record whose distro is gone fails its connect rather than answering null.
    if (settleInterrupted && (await resetForUnregisteredDistro(deps, request))) {
      return refusal('wsl_move_host_unavailable', { detail: 'distro_unregistered' })
    }
    // Nothing is recorded yet, so a host that will not connect is the user's to fix, not a failure.
    console.warn('[wsl-move] The host did not connect:', error)
    return refusal('wsl_move_host_unavailable', { detail: 'connect_failed' })
  }
  if (!host) {
    if (settleInterrupted && (await resetForUnregisteredDistro(deps, request))) {
      return refusal('wsl_move_host_unavailable', { detail: 'distro_unregistered' })
    }
    return refusal('wsl_move_host_unavailable')
  }
  if (wslMoveHostReadiness(host.capabilities) !== 'ready') {
    return refusal('wsl_move_host_update_required')
  }
  const unsettled = settleInterrupted ? await settleInterruptedWslMove(deps, host, request) : null
  if (unsettled) {
    return unsettled
  }
  const selection =
    request.repoIds || request.folderWorkspaceIds
      ? { repoIds: request.repoIds ?? [], folderWorkspaceIds: request.folderWorkspaceIds ?? [] }
      : undefined
  const planned = planWslMove(
    deps.userDataPath,
    deps.readCatalog(),
    request.distro,
    await host.readHolding(),
    selection
  )
  if (planned.outcome === 'refused') {
    return refusal(planned.code)
  }
  const { plan } = planned
  // A delta goes to the host its chain already moved into; another host would split the projects.
  if (plan.destinationEnvironmentId && plan.destinationEnvironmentId !== host.environmentId) {
    return refusal('wsl_move_host_unavailable', { detail: 'destination_changed' })
  }
  let exported: WslMoveManifestExport
  try {
    exported = deps.exportManifest(exportRequestOf({ plan, host }, migrationId, startedAt))
    if (exported.blockers.length > 0) {
      return refusal('wsl_move_export_incomplete', { reasons: [...exported.blockers] })
    }
    assertWslMoveManifestFits(exported.manifest)
  } catch (error) {
    const tooLarge = manifestTooLargeRefusal(error)
    if (tooLarge) {
      return tooLarge
    }
    if (isWslMoveScopeChanged(error)) {
      return refusal('wsl_move_scope_changed')
    }
    throw error
  }
  const scope: WslMoveTerminalScope = {
    workspaceIds: exported.workspaceIds,
    workspaceKeys: new Set(exported.workspaceKeys)
  }
  const gate = assessWslMoveTerminals(await deps.gateInputs(scope))
  return {
    host,
    plan,
    exported,
    scope,
    blockers: gate.verdict === 'blocked' ? gate.blockers : []
  }
}
