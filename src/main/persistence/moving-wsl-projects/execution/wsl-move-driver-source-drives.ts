/**
 * The mapped drives a move plans with: read fresh at preview, and at start again. The start then
 * refuses when the drives its own planned rows name differ from what the preview showed (the start
 * request carries them back). With them, the mapped-drive repos the host's Git can't take.
 */
import {
  WSL_MOVE_MAPPED_DRIVE_UNVERIFIABLE_DETAIL,
  type WslMoveDroppedProject,
  type WslMoveRefusal,
  type WslMoveRequest
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  sameWslMappedDrives,
  type WslMappedDrive
} from '../../../../shared/wsl-move/wsl-mapped-drive-paths'
import {
  readWslMoveMappedDrives,
  wslMoveDriveLetterOf,
  wslMoveDriveLettersInUse
} from '../manifest-scope/wsl-move-mapped-drives'
import { isLocalWslMoveRow } from '../quiescence/wsl-move-scope-guard'
import type { WslMoveScopeDrives, WslMoveScopeRefusal } from '../manifest-scope/wsl-move-scope'
import { findWindowsGitRefusals } from '../manifest-scope/wsl-move-windows-git-worktrees'
import type { WslMoveCatalogRows, WslMoveDriverDeps } from './wsl-move-driver-ports'

export type WslMoveSourceDrives = Required<WslMoveScopeDrives> & {
  mappedDrives: WslMappedDrive[]
  windowsGitRefusals: ReadonlyMap<string, WslMoveScopeRefusal>
}

/** The letters of the rows a request names; null when it names none (the whole distro). */
function namedLetters(
  catalog: WslMoveCatalogRows,
  request: Pick<WslMoveRequest, 'repoIds' | 'folderWorkspaceIds'>
): string[] | null {
  if (!request.repoIds && !request.folderWorkspaceIds) {
    return null
  }
  return wslMoveDriveLettersInUse({
    repos: catalog.repos.filter((repo) => request.repoIds?.includes(repo.id)),
    folderWorkspaces: catalog.folderWorkspaces.filter((folder) =>
      request.folderWorkspaceIds?.includes(folder.id)
    )
  })
}

export async function readWslMoveSourceDrives(
  deps: Pick<WslMoveDriverDeps, 'driveShares' | 'windowsGitVerdict'>,
  catalog: WslMoveCatalogRows,
  request: WslMoveRequest
): Promise<WslMoveSourceDrives> {
  const read = deps.driveShares
    ? await readWslMoveMappedDrives(catalog, request.distro, deps.driveShares)
    : { mappedDrives: [], unansweredDrives: [], unknownLetters: [] }
  const named = namedLetters(catalog, request) ?? []
  // An unclassified drive (an offline share, say) is this distro's to list only when picked.
  const unverifiableLetters = [
    ...read.unansweredDrives.map((drive) => drive.letter),
    ...read.unknownLetters.filter((letter) => named.includes(letter))
  ]
  // An unanswered drive's repos are checked through their last share, so a Git reason shows.
  const gitDrives = [...read.mappedDrives, ...read.unansweredDrives]
  const windowsGitRefusals =
    deps.windowsGitVerdict && gitDrives.length > 0
      ? await findWindowsGitRefusals(
          catalog.repos,
          request.distro,
          gitDrives,
          deps.windowsGitVerdict
        )
      : new Map<string, WslMoveScopeRefusal>()
  return { mappedDrives: read.mappedDrives, unverifiableLetters, windowsGitRefusals }
}

/** The drives a move journals: only those its exported paths named, so a UNC move stays v1. */
export function journaledWslMoveDrives(
  mappedDrives: readonly WslMappedDrive[],
  exportedLetters: readonly string[] | undefined
): WslMappedDrive[] {
  if (!exportedLetters) {
    return [...mappedDrives]
  }
  const named = new Set(exportedLetters)
  return mappedDrives.filter((drive) => named.has(drive.letter.toUpperCase()))
}

/**
 * At start: the drives this start will journal, and those of the rows it names, must map where
 * the preview showed. Hidden, retained, refused or unrelated rows never count.
 */
export function wslMoveStartDriveRefusal(
  catalog: WslMoveCatalogRows,
  request: WslMoveRequest,
  drives: Pick<WslMoveSourceDrives, 'mappedDrives' | 'unverifiableLetters'>,
  journaled: readonly WslMappedDrive[],
  expected: readonly WslMappedDrive[]
): WslMoveRefusal | null {
  const named = namedLetters(catalog, request)
  // A drive the preview showed, or one a picked row uses, that no longer answers.
  const needed = new Set([...expected.map((drive) => drive.letter.toUpperCase()), ...(named ?? [])])
  if (drives.unverifiableLetters.some((letter) => needed.has(letter))) {
    return {
      outcome: 'refused',
      code: 'wsl_move_unavailable',
      detail: WSL_MOVE_MAPPED_DRIVE_UNVERIFIABLE_DETAIL
    }
  }
  const relevant = new Set([
    ...journaled.map((drive) => drive.letter.toUpperCase()),
    ...(named ?? [])
  ])
  const only = (list: readonly WslMappedDrive[]): WslMappedDrive[] =>
    list.filter((drive) => relevant.has(drive.letter.toUpperCase()))
  return sameWslMappedDrives(only(expected), only(drives.mappedDrives))
    ? null
    : { outcome: 'refused', code: 'wsl_move_scope_changed', detail: 'mapped-drives-changed' }
}

/**
 * A whole-distro start's projects that the preview could show but this start leaves, because
 * their drive now points elsewhere (or no longer answers): named in the result, never silent.
 */
export function wslMoveDroppedForDrives(
  catalog: WslMoveCatalogRows,
  fresh: readonly WslMappedDrive[],
  expected: readonly WslMappedDrive[],
  moving: { repoIds: readonly string[]; folderWorkspaceIds: readonly string[] }
): WslMoveDroppedProject[] {
  const changed = new Set(
    expected
      .filter((seen) => {
        const now = fresh.find((drive) => drive.letter === seen.letter)
        return !now || !sameWslMappedDrives([seen], [now])
      })
      .map((drive) => drive.letter.toUpperCase())
  )
  const onChanged = (row: { path: string; orcadRetained?: unknown }): boolean =>
    // A retained row was moved earlier; it isn't this start's to leave.
    !row.orcadRetained && changed.has(wslMoveDriveLetterOf(row.path) ?? '')
  return [
    ...catalog.repos
      .filter((repo) => isLocalWslMoveRow(repo) && !moving.repoIds.includes(repo.id))
      .filter((repo) => onChanged(repo))
      .map((repo) => ({ kind: 'repo' as const, id: repo.id, name: repo.displayName })),
    ...catalog.folderWorkspaces
      .filter(
        (folder) => isLocalWslMoveRow(folder) && !moving.folderWorkspaceIds.includes(folder.id)
      )
      .filter((folder) =>
        onChanged({ path: folder.folderPath, orcadRetained: folder.orcadRetained })
      )
      .map((folder) => ({ kind: 'folder' as const, id: folder.id, name: folder.name }))
  ]
}

/**
 * `wslMoveDroppedForDrives`, less the repos the Git-for-Windows check refuses through the share
 * the preview read: the preview showed those with Git's reason, never as moving.
 */
export async function wslMoveStartDroppedProjects(
  deps: Pick<WslMoveDriverDeps, 'windowsGitVerdict'>,
  catalog: WslMoveCatalogRows,
  distro: string,
  fresh: readonly WslMappedDrive[],
  expected: readonly WslMappedDrive[],
  moving: { repoIds: readonly string[]; folderWorkspaceIds: readonly string[] }
): Promise<WslMoveDroppedProject[]> {
  const dropped = wslMoveDroppedForDrives(catalog, fresh, expected, moving)
  const repos = catalog.repos.filter((repo) =>
    dropped.some((project) => project.kind === 'repo' && project.id === repo.id)
  )
  if (!deps.windowsGitVerdict || repos.length === 0) {
    return dropped
  }
  const refused = await findWindowsGitRefusals(repos, distro, expected, deps.windowsGitVerdict)
  const gitReason = (id: string): boolean => {
    const reason = refused.get(id)
    return reason === 'windows-git-worktrees' || reason === 'windows-git-dir'
  }
  return dropped.filter((project) => project.kind !== 'repo' || !gitReason(project.id))
}
