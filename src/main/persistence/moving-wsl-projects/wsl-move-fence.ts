// Journal-backed fences survive older builds rewriting the profile; freeze quiesced sessions for downgrade.
import type { WslMoveCutover, WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import { WSL_MOVE_CUTOVER_PHASES } from '../../../shared/wsl-move/wsl-move-cutover'
import { scanWslMoveCutovers } from './wsl-move-cutover-journal'
import { comparableWslPath } from './wsl-move-comparable-path'
import { wslMoveScopeRootPaths } from './wsl-move-scope-roots'
import {
  listWslDriveUncConversions,
  type WslDriveUncConversion
} from '../../wsl/wsl-drive-unc-conversion-journal'

export type WslMoveScopeIds = {
  repoIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
}

export type WslMoveFenceState = {
  /** Read-only projects shown as Moving. */
  fenced: WslMoveScopeIds
  /** Retained for downgrade, hidden once the host owns them. */
  hidden: WslMoveScopeIds
  /** Preserve quiesced sessions through commit. */
  sessionFrozen: WslMoveScopeIds
  /** The fenced moves' folders, per distro and comparable, for a spawn that names no workspace. */
  fencedRoots: readonly WslMoveFencedRoots[]
  /** The distro whose host owns each hidden row, for the retained entry's label. */
  hostDistro: {
    repoIds: ReadonlyMap<string, string>
    folderWorkspaceIds: ReadonlyMap<string, string>
  }
}

export type WslMoveFencedRoots = { distro: string; roots: readonly string[] }

const phaseIndex = (phase: WslMoveCutoverPhase): number => WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
const FENCED_FROM = phaseIndex('source-fenced')
const HIDDEN_FROM = phaseIndex('destination-committed')
// Sleep writes session state after source-fenced, so freeze only after quiesce.
const SESSION_FROZEN_FROM = phaseIndex('quiesced')

/** Unreadable journals force callers to fence every WSL project. */
export function resolveWslMoveFence(userDataPath: string): WslMoveFenceState {
  return withWslDriveUncConversions(
    wslMoveFenceFromCutovers(scanWslMoveCutovers(userDataPath)),
    listWslDriveUncConversions(userDataPath)
  )
}

/**
 * A Windows-drive conversion fences its projects from the pause until the next startup rewrites
 * them: a terminal started in between would keep the old worktree id. After the profile rewrite
 * the projects are ordinary again, even while another store retries.
 */
export function withWslDriveUncConversions(
  fence: WslMoveFenceState,
  conversions: readonly WslDriveUncConversion[]
): WslMoveFenceState {
  const pending = conversions.filter((conversion) => conversion.phase === 'prepared')
  if (pending.length === 0) {
    return fence
  }
  const fenced = {
    repoIds: new Set([...fence.fenced.repoIds, ...pending.flatMap((entry) => entry.repoIds)]),
    folderWorkspaceIds: new Set([
      ...fence.fenced.folderWorkspaceIds,
      ...pending.flatMap((entry) => entry.folderWorkspaceIds)
    ])
  }
  const fencedRoots = [
    ...fence.fencedRoots,
    ...pending.map(({ distro, rootPaths }) => ({
      distro,
      roots: rootPaths.flatMap((root) => comparableWslPath(root, distro) ?? [])
    }))
  ]
  return { ...fence, fenced, fencedRoots }
}

export function wslMoveFenceFromCutovers(
  cutovers: readonly Readonly<WslMoveCutover>[]
): WslMoveFenceState {
  const fenced = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  const hidden = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  const sessionFrozen = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  const hostDistro = {
    repoIds: new Map<string, string>(),
    folderWorkspaceIds: new Map<string, string>()
  }
  const fencedRoots: WslMoveFencedRoots[] = []
  for (const cutover of cutovers) {
    const index = phaseIndex(cutover.phase)
    const target = index >= HIDDEN_FROM ? hidden : index >= FENCED_FROM ? fenced : null
    if (!target) {
      continue
    }
    addScope(target, cutover)
    if (target === fenced) {
      fencedRoots.push(fencedRootsOf(cutover))
    }
    if (target === hidden) {
      const { distro, scopeRepoIds, scopeFolderWorkspaceIds } = cutover.manifest.source
      scopeRepoIds.forEach((id) => hostDistro.repoIds.set(id, distro))
      scopeFolderWorkspaceIds.forEach((id) => hostDistro.folderWorkspaceIds.set(id, distro))
    }
    // Keep retained sessions frozen even after the destination commits.
    if (index >= SESSION_FROZEN_FROM) {
      addScope(sessionFrozen, cutover)
    }
  }
  return { fenced, hidden, sessionFrozen, hostDistro, fencedRoots }
}

function fencedRootsOf(cutover: Readonly<WslMoveCutover>): WslMoveFencedRoots {
  const { distro } = cutover.manifest.source
  const roots = wslMoveScopeRootPaths(cutover.manifest).flatMap(
    (root) => comparableWslPath(root, distro) ?? []
  )
  return { distro, roots }
}

function addScope(
  target: { repoIds: Set<string>; folderWorkspaceIds: Set<string> },
  cutover: Readonly<WslMoveCutover>
): void {
  const { scopeRepoIds, scopeFolderWorkspaceIds } = cutover.manifest.source
  for (const id of scopeRepoIds) {
    target.repoIds.add(id)
  }
  for (const id of scopeFolderWorkspaceIds) {
    target.folderWorkspaceIds.add(id)
  }
}
