// Journal-backed fences survive older builds rewriting the profile; freeze quiesced sessions for downgrade.
import type { WslMoveCutover, WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import { WSL_MOVE_CUTOVER_PHASES } from '../../../shared/wsl-move/wsl-move-cutover'
import { scanWslMoveCutovers } from './wsl-move-cutover-journal'

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
}

const phaseIndex = (phase: WslMoveCutoverPhase): number => WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
const FENCED_FROM = phaseIndex('source-fenced')
const HIDDEN_FROM = phaseIndex('destination-committed')
// Sleep writes session state after source-fenced, so freeze only after quiesce.
const SESSION_FROZEN_FROM = phaseIndex('quiesced')

/** Unreadable journals force callers to fence every WSL project. */
export function resolveWslMoveFence(userDataPath: string): WslMoveFenceState {
  return wslMoveFenceFromCutovers(scanWslMoveCutovers(userDataPath))
}

export function wslMoveFenceFromCutovers(
  cutovers: readonly Readonly<WslMoveCutover>[]
): WslMoveFenceState {
  const fenced = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  const hidden = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  const sessionFrozen = { repoIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
  for (const cutover of cutovers) {
    const index = phaseIndex(cutover.phase)
    const target = index >= HIDDEN_FROM ? hidden : index >= FENCED_FROM ? fenced : null
    if (!target) {
      continue
    }
    addScope(target, cutover)
    // Keep retained sessions frozen even after the destination commits.
    if (index >= SESSION_FROZEN_FROM) {
      addScope(sessionFrozen, cutover)
    }
  }
  return { fenced, hidden, sessionFrozen }
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
