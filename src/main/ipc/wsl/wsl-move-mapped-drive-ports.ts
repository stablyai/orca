/** The move's view of drive letters mapped into a distro; Windows only. */
import type { Store } from '../../persistence/loading-store/store'
import type { WslMoveDriverDeps } from '../../persistence/moving-wsl-projects/execution/wsl-move-driver-ports'
import { wslMoveDriveLettersInUse } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-mapped-drives'
import { windowsGitWorktreeVerdict } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-windows-git-worktrees'
import type { WslMappedDrive } from '../../../shared/wsl-move/wsl-mapped-drive-paths'
import {
  classifyWslMappedDrive,
  readWslMappedDriveShareNow,
  wslMappedDriveMatches
} from '../../wsl/filesystem/wsl-mapped-drive-share'
import { wslMappedDriveLastKnownShare } from '../../wsl/filesystem/wsl-mapped-drive-last-known'

export function wslMoveMappedDrivePorts(): Pick<
  WslMoveDriverDeps,
  'driveShares' | 'windowsGitVerdict'
> {
  return process.platform === 'win32'
    ? {
        driveShares: {
          classify: (letter) => classifyWslMappedDrive(letter),
          readNow: (letter) => readWslMappedDriveShareNow(letter)
        },
        windowsGitVerdict: windowsGitWorktreeVerdict
      }
    : {}
}

/**
 * For the orchestrator's prune check, which runs in the background: last-known answers only, so it
 * never reads a drive (a mapped share's read can boot its stopped distro). Unknown is in use.
 */
export function wslMoveDistroMappedDrivesLastKnown(
  store: Pick<Store, 'getRepos' | 'getFolderWorkspaces'>,
  distro: string
): readonly WslMappedDrive[] | 'unverifiable' {
  if (process.platform !== 'win32') {
    return []
  }
  const letters = wslMoveDriveLettersInUse({
    repos: store.getRepos(),
    folderWorkspaces: store.getFolderWorkspaces()
  })
  const mapped: WslMappedDrive[] = []
  for (const letter of letters) {
    const known = wslMappedDriveLastKnownShare(letter)
    if (!known) {
      return 'unverifiable'
    }
    if (wslMappedDriveMatches(known.share, distro, undefined)) {
      mapped.push({ letter, share: known.share })
    }
  }
  return mapped
}
