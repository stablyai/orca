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

type WslMoveIds = { repoIds: readonly string[]; folderWorkspaceIds: readonly string[] }

/**
 * The projects this start leaves that the preview showed moving and the request asked for, so
 * none goes unreported. A request without the preview's rows (an older window) falls back to the
 * local rows on a drive that changed since the preview.
 */
export function wslMoveStartDroppedProjects(
  catalog: WslMoveCatalogRows,
  request: Pick<WslMoveRequest, 'repoIds' | 'folderWorkspaceIds' | 'previewMoving'>,
  fresh: readonly WslMappedDrive[],
  expected: readonly WslMappedDrive[],
  moving: WslMoveIds
): WslMoveDroppedProject[] {
  const asked: WslMoveIds | null =
    request.repoIds || request.folderWorkspaceIds
      ? { repoIds: request.repoIds ?? [], folderWorkspaceIds: request.folderWorkspaceIds ?? [] }
      : null
  const previewed = request.previewMoving ?? null
  const onChanged = changedDriveRows(fresh, expected)
  const left = (
    kind: keyof WslMoveIds,
    id: string,
    row: { path: string; orcadRetained?: unknown }
  ) =>
    !moving[kind].includes(id) &&
    (!asked || asked[kind].includes(id)) &&
    (previewed ? previewed[kind].includes(id) : onChanged(row))
  return [
    ...catalog.repos
      .filter((repo) => isLocalWslMoveRow(repo) && left('repoIds', repo.id, repo))
      .map((repo) => ({ kind: 'repo' as const, id: repo.id, name: repo.displayName })),
    ...catalog.folderWorkspaces
      .filter(
        (folder) =>
          isLocalWslMoveRow(folder) &&
          left('folderWorkspaceIds', folder.id, {
            path: folder.folderPath,
            orcadRetained: folder.orcadRetained
          })
      )
      .map((folder) => ({ kind: 'folder' as const, id: folder.id, name: folder.name }))
  ]
}

/** Whether a row sits on a drive that maps elsewhere (or no longer answers) since the preview. */
function changedDriveRows(
  fresh: readonly WslMappedDrive[],
  expected: readonly WslMappedDrive[]
): (row: { path: string; orcadRetained?: unknown }) => boolean {
  const changed = new Set(
    expected
      .filter((seen) => {
        const now = fresh.find((drive) => drive.letter === seen.letter)
        return !now || !sameWslMappedDrives([seen], [now])
      })
      .map((drive) => drive.letter.toUpperCase())
  )
  // A retained row was moved earlier; it isn't this start's to leave.
  return (row) => !row.orcadRetained && changed.has(wslMoveDriveLetterOf(row.path) ?? '')
}
