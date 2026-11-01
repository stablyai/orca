/**
 * A committed WSL move's source rows, as this build keeps them (mover design, section 4.5). The
 * journal hides them; the `orcadRetained` mark records, on the row itself, which move took it and
 * whether an older build changed it since. Only identity counts as a change, as for SSH: an older
 * build's tabs and edits inside a moved project stay in the retained rows.
 */
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { OrcadRetainedMarker } from '../../../shared/orcad-retained-marker'
import type { Repo } from '../../../shared/repo-types'
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutover
} from '../../../shared/wsl-move/wsl-move-cutover'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import type { WslMoveRetainedMark } from './wsl-move-retained-marks'
import { isLocalWslMoveRow } from './wsl-move-scope-guard'

export type WslMoveRowKind = 'repo' | 'folder'
export type WslMoveRowRef = { kind: WslMoveRowKind; id: string }

type IdentityRow = Pick<Repo, 'id' | 'path' | 'displayName'> | FolderIdentityRow
type FolderIdentityRow = Pick<FolderWorkspace, 'id' | 'folderPath' | 'name'>

function isFolderRow(row: IdentityRow): row is FolderIdentityRow {
  return 'folderPath' in row
}

/** Id, Linux path and name: what the host's copy of the row was created from. */
function identity(row: IdentityRow, toLinux: (path: string) => string): string {
  return isFolderRow(row)
    ? JSON.stringify([row.id, toLinux(row.folderPath), row.name])
    : JSON.stringify([row.id, toLinux(row.path), row.displayName])
}

/** The local row as the move would export it today. */
export function wslMoveLocalRowIdentity(row: IdentityRow, distro: string): string {
  const rewriter = createUncToLinuxPathRewriter(distro)
  return identity(row, (path) => rewriter.path(path, 'absolute'))
}

/** The row as the move took it; null when its manifest does not carry the row. */
export function wslMoveTakenRowIdentity(
  cutover: Pick<WslMoveCutover, 'manifest'>,
  ref: WslMoveRowRef
): string | null {
  const { payload } = cutover.manifest
  const row =
    ref.kind === 'repo'
      ? payload.repositories.find((entry) => entry.id === ref.id)
      : payload.folderWorkspaces.find((entry) => entry.id === ref.id)
  // Manifest paths are already in Linux form.
  return row ? identity(row, (path) => path) : null
}

export function wslMoveScopeRefs(cutover: Pick<WslMoveCutover, 'manifest'>): WslMoveRowRef[] {
  const { scopeRepoIds, scopeFolderWorkspaceIds } = cutover.manifest.source
  return [
    ...scopeRepoIds.map((id) => ({ kind: 'repo' as const, id })),
    ...scopeFolderWorkspaceIds.map((id) => ({ kind: 'folder' as const, id }))
  ]
}

export const wslMoveRowKey = (ref: WslMoveRowRef): string => `${ref.kind}:${ref.id}`

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

export type WslMoveRetainedMarkPlan = {
  marks: WslMoveRetainedMark[]
  /** Retained rows whose identity an older build changed: candidates for a later move. */
  changed: WslMoveRowRef[]
}

/**
 * The marks every local row should carry. `chains` are each distro's moves, oldest first; a move
 * in `retaining` counts as retained, since its marks are what make it so.
 */
export function planWslMoveRetainedMarks(input: {
  chains: readonly (readonly Readonly<WslMoveCutover>[])[]
  retaining: ReadonlySet<string>
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  now: string
}): WslMoveRetainedMarkPlan {
  const owners = new Map<string, Readonly<WslMoveCutover>>()
  // Committed moves by id, with the rows each took.
  const committed = new Map<string, Set<string>>()
  for (const chain of input.chains) {
    for (const cutover of chain) {
      if (WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_FROM) {
        committed.set(cutover.migrationId, new Set(wslMoveScopeRefs(cutover).map(wslMoveRowKey)))
      }
      if (cutover.phase !== 'retained' && !input.retaining.has(cutover.migrationId)) {
        continue
      }
      // Oldest first, so a later move that took the row again wins.
      for (const ref of wslMoveScopeRefs(cutover)) {
        owners.set(wslMoveRowKey(ref), cutover)
      }
    }
  }
  const plan: WslMoveRetainedMarkPlan = { marks: [], changed: [] }
  const visit = (
    ref: WslMoveRowRef,
    row: IdentityRow,
    current: OrcadRetainedMarker | undefined
  ) => {
    const owner = owners.get(wslMoveRowKey(ref))
    if (!owner) {
      // A dropped move ("Use on this computer again"), or one that never took this row.
      if (current && !committed.get(current.migrationId)?.has(wslMoveRowKey(ref))) {
        plan.marks.push({ ...ref, marker: null })
      }
      return
    }
    const changed =
      wslMoveTakenRowIdentity(owner, ref) !==
      wslMoveLocalRowIdentity(row, owner.manifest.source.distro)
    if (changed) {
      plan.changed.push(ref)
    }
    const keptChangedAt =
      current?.migrationId === owner.migrationId ? current.sourceChangedAt : undefined
    const marker: OrcadRetainedMarker = {
      migrationId: owner.migrationId,
      environmentId: owner.destinationEnvironmentId,
      ...(changed ? { sourceChangedAt: keptChangedAt ?? input.now } : {})
    }
    plan.marks.push({ ...ref, marker })
  }
  for (const repo of input.repos) {
    if (isLocalWslMoveRow(repo)) {
      visit({ kind: 'repo', id: repo.id }, repo, repo.orcadRetained)
    }
  }
  for (const folder of input.folderWorkspaces) {
    if (isLocalWslMoveRow(folder)) {
      visit({ kind: 'folder', id: folder.id }, folder, folder.orcadRetained)
    }
  }
  return plan
}
