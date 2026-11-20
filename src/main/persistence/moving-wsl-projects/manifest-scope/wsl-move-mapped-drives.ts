/**
 * The drive letters mapped into a distro (`net use W: \\wsl.localhost\Ubuntu`) that local
 * projects are saved under. Only a letter last known to map into WSL is read again, fresh, for
 * each preview and start; C:, D: or another network share is never touched after it is known.
 */
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WslMappedDrive } from '../../../../shared/wsl-move/wsl-mapped-drive-paths'
import {
  wslMappedDriveMatches,
  type WslMappedDriveRead
} from '../../../wsl/filesystem/wsl-mapped-drive-share'
import { isLocalWslMoveRow } from '../quiescence/wsl-move-scope-guard'
import { wslMoveRepoPaths } from './wsl-move-scope'

export type WslMoveDriveShares = {
  /** The letter's last known share; an unknown letter gets one bounded, cached lookup. */
  classify: (letter: string) => Promise<{ share: string | null } | null>
  /** Fresh from Windows, bounded; concurrent reads of a letter share one lookup. */
  readNow: (letter: string) => Promise<WslMappedDriveRead>
}

export type WslMoveMappedDrivesRead = {
  mappedDrives: WslMappedDrive[]
  /** Drives last known to map into this distro, with that share, that didn't answer now. */
  unansweredDrives: WslMappedDrive[]
  /** Letters never classified (the lookup timed out): they may map anywhere, or nowhere. */
  unknownLetters: string[]
}

const DRIVE_PATH = /^([A-Za-z]):[\\/]/

export function wslMoveDriveLetterOf(path: string): string | null {
  return DRIVE_PATH.exec(path)?.[1].toUpperCase() ?? null
}

/** The distinct drive letters, uppercase, every path the move's scope reads names. */
export function wslMoveDriveLettersInUse(rows: {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
}): string[] {
  const paths = [
    ...rows.repos.filter(isLocalWslMoveRow).flatMap((repo) => wslMoveRepoPaths(repo)),
    ...rows.folderWorkspaces.filter(isLocalWslMoveRow).map((folder) => folder.folderPath)
  ]
  const letters = new Set(paths.flatMap((path) => wslMoveDriveLetterOf(path) ?? []))
  return [...letters].sort()
}

type LetterRead =
  | { mapped: WslMappedDrive }
  | { unanswered: WslMappedDrive }
  | 'unknown'
  | 'elsewhere'

async function readLetter(
  letter: string,
  distro: string,
  shares: WslMoveDriveShares
): Promise<LetterRead> {
  const known = await shares.classify(letter).catch(() => null)
  if (known === null) {
    return 'unknown'
  }
  if (known.share === null || !parseWslUncPath(known.share)) {
    return 'elsewhere'
  }
  const read = await shares.readNow(letter).catch((): WslMappedDriveRead => 'unverifiable')
  if (read === 'unverifiable') {
    // Last known in another distro: its projects aren't this move's to list.
    return wslMappedDriveMatches(known.share, distro, undefined)
      ? { unanswered: { letter, share: known.share } }
      : 'elsewhere'
  }
  return wslMappedDriveMatches(read.share, distro, undefined)
    ? { mapped: { letter, share: read.share } }
    : 'elsewhere'
}

export async function readWslMoveMappedDrives(
  rows: { repos: readonly Repo[]; folderWorkspaces: readonly FolderWorkspace[] },
  distro: string,
  shares: WslMoveDriveShares
): Promise<WslMoveMappedDrivesRead> {
  const letters = wslMoveDriveLettersInUse(rows)
  const reads = await Promise.all(
    letters.map(async (letter) => ({ letter, read: await readLetter(letter, distro, shares) }))
  )
  return {
    mappedDrives: reads.flatMap(({ read }) =>
      typeof read === 'object' && 'mapped' in read ? [{ ...read.mapped }] : []
    ),
    unansweredDrives: reads.flatMap(({ read }) =>
      typeof read === 'object' && 'unanswered' in read ? [{ ...read.unanswered }] : []
    ),
    unknownLetters: reads.filter(({ read }) => read === 'unknown').map(({ letter }) => letter)
  }
}
