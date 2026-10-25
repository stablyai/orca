/**
 * The escape hatch for a moved project (no reverse mover, owner decision 2): drop the committed
 * move so the retained source rows, untouched since the move, are listed here again. Nothing is
 * copied back from the WSL host; the host keeps its own copy until the user removes it there.
 * The repository files never moved, so code is never at stake, only Orca's own state.
 */
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutover
} from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveUseLocallyResult } from '../../../shared/wsl-move/wsl-moved-project'
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import { isWslMoveRunning } from './wsl-move-running-moves'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers,
  removeCommittedWslMoveCutover
} from './wsl-move-cutover-journal'
import { type WslMoveProjectRef, wslMoveProjectRefForWorkspace } from './wsl-move-scope-guard'

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

function inScope(cutover: WslMoveCutover, ref: WslMoveProjectRef): boolean {
  const { scopeRepoIds, scopeFolderWorkspaceIds } = cutover.manifest.source
  return 'repoId' in ref
    ? scopeRepoIds.includes(ref.repoId)
    : scopeFolderWorkspaceIds.includes(ref.folderWorkspaceId)
}

/** The workspaces among `workspaceIds` whose projects the move brings back. */
export function wslMoveWorkspacesInScope(
  move: WslMoveCutover,
  workspaceIds: readonly string[]
): string[] {
  return workspaceIds.filter((workspaceId) => {
    const ref = wslMoveProjectRefForWorkspace(workspaceId)
    return ref !== null && inScope(move, ref)
  })
}

/** The committed move that holds the project, newest in its distro's chain, or why there is none. */
export function findWslMovedProjectMove(
  userDataPath: string,
  ref: WslMoveProjectRef
): { move: WslMoveCutover } | Extract<WslMoveUseLocallyResult, { released: false }> {
  if (!wslHostsGateOpen()) {
    return { released: false, reason: 'gated-off' }
  }
  let move: WslMoveCutover | undefined
  try {
    const taken = listWslMoveCutovers(userDataPath).find(
      (cutover) =>
        WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_FROM && inScope(cutover, ref)
    )
    // Newest in its distro's chain: a later delta move may carry the project on.
    move = taken
      ? listWslMoveCutoverChain(userDataPath, taken.journalKey).findLast((cutover) =>
          inScope(cutover, ref)
        )
      : undefined
  } catch (error) {
    return { released: false, reason: 'failed', detail: describe(error) }
  }
  if (!move) {
    return { released: false, reason: 'not-moved' }
  }
  // The running driver still writes this record; dropping it under the driver loses its outcome.
  if (isWslMoveRunning(move.manifest.source.distro)) {
    return { released: false, reason: 'move-running' }
  }
  return { move }
}

/**
 * Why `releaseWslMove` would refuse, read without changing anything, so undo can refuse before it
 * stops the host's copies; null when the release would go ahead.
 */
export function wslMoveReleaseRefusal(
  userDataPath: string,
  move: WslMoveCutover
): Extract<WslMoveUseLocallyResult, { released: false }> | null {
  if (isWslMoveRunning(move.manifest.source.distro)) {
    return { released: false, reason: 'move-running' }
  }
  try {
    const newest = listWslMoveCutoverChain(userDataPath, move.journalKey).at(-1)
    return newest && newest.migrationId !== move.migrationId
      ? { released: false, reason: 'superseded', ...newerMoveOf(userDataPath, move) }
      : null
  } catch (error) {
    return { released: false, reason: 'failed', detail: describe(error) }
  }
}

/** Drops the committed move so its retained source rows list here again. */
export function releaseWslMove(
  userDataPath: string,
  move: WslMoveCutover
): WslMoveUseLocallyResult {
  if (isWslMoveRunning(move.manifest.source.distro)) {
    return { released: false, reason: 'move-running' }
  }
  try {
    removeCommittedWslMoveCutover(userDataPath, move.migrationId)
  } catch (error) {
    const detail = describe(error)
    return detail === 'wsl_move_superseded'
      ? { released: false, reason: 'superseded', ...newerMoveOf(userDataPath, move) }
      : { released: false, reason: 'failed', detail }
  }
  const { scopeRepoIds, scopeFolderWorkspaceIds } = move.manifest.source
  return {
    released: true,
    distro: move.manifest.source.distro,
    repoIds: [...scopeRepoIds],
    folderWorkspaceIds: [...scopeFolderWorkspaceIds]
  }
}

export function bringWslMovedProjectBack(
  userDataPath: string,
  ref: WslMoveProjectRef
): WslMoveUseLocallyResult {
  const found = findWslMovedProjectMove(userDataPath, ref)
  return 'move' in found ? releaseWslMove(userDataPath, found.move) : found
}

/** The move that has to come back first, so the refusal can name its projects. */
function newerMoveOf(
  userDataPath: string,
  move: WslMoveCutover
): { newerMove?: { repoIds: string[]; folderWorkspaceIds: string[] } } {
  try {
    const newest = listWslMoveCutoverChain(userDataPath, move.journalKey).at(-1)
    if (!newest || newest.migrationId === move.migrationId) {
      return {}
    }
    const { scopeRepoIds, scopeFolderWorkspaceIds } = newest.manifest.source
    return {
      newerMove: { repoIds: [...scopeRepoIds], folderWorkspaceIds: [...scopeFolderWorkspaceIds] }
    }
  } catch {
    return {}
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
