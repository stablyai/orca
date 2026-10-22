/**
 * What the WSL move journal fences on this desktop. The journal itself is the fence: it already
 * lives outside the profile store, so an older build rewriting the profile cannot drop it, and the
 * scope it names is the manifest's own (design, section 4.3).
 *
 * - Fenced (read-only): from `source-fenced` until the host owns the projects. Edits and new
 *   terminals are refused.
 * - Hidden: once the destination committed. The source rows stay (retained) but are not listed.
 * - Session frozen: from `quiesced` on, hidden or not, the session stays as the quiesce left it.
 */
import type { WslMoveCutover, WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import { WSL_MOVE_CUTOVER_PHASES } from '../../../shared/wsl-move/wsl-move-cutover'
import { scanWslMoveCutovers } from './wsl-move-cutover-journal'
import { comparableWslPath } from './wsl-move-comparable-path'
import { wslMoveScopeRootPaths } from './wsl-move-scope-roots'

export type WslMoveScopeIds = {
  repoIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
}

export type WslMoveFenceState = {
  /** Rows a move is taking right now: shown as "Moving…", and read-only. */
  fenced: WslMoveScopeIds
  /** Rows the WSL host now owns: kept for a downgrade, never listed. */
  hidden: WslMoveScopeIds
  /** Rows already paused, through commit: their session stays as the quiesce left it. */
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
// Why not from `source-fenced`: the quiesce's own Sleep writes the slept panes' session after that.
const SESSION_FROZEN_FROM = phaseIndex('quiesced')

/** Throws when the journal cannot be read: callers keep every WSL project fenced then. */
export function resolveWslMoveFence(userDataPath: string): WslMoveFenceState {
  return wslMoveFenceFromCutovers(scanWslMoveCutovers(userDataPath))
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
      continue // `prepared` touches nothing on the source.
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
    // Through commit too: the retained local rows are what a downgrade restores.
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
