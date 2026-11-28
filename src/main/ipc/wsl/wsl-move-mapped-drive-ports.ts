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
import type { WslMoveInUseCheck } from '../../persistence/moving-wsl-projects/orchestration/wsl-move-orchestrator-ports'

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

let systemDrive: string | null | undefined

/** `%SystemDrive%`'s letter, read once; null when unset, so every letter stays unverifiable. */
function windowsSystemDriveLetter(): string | null {
  if (systemDrive === undefined) {
    const match = /^([A-Za-z]):\\?$/.exec(process.env.SystemDrive?.trim() ?? '')
    systemDrive = match ? match[1].toUpperCase() : null
  }
  return systemDrive
}

/**
 * For the orchestrator's hold and prune checks, which run in the background: last-known answers
 * only, so it never reads a drive (a mapped share's read can boot its stopped distro). Unknown is
 * in use. The system drive is local (`net use` can't remap a local device), so it is never a share.
 * A failed lookup's null proves nothing; one saved before lookups were recorded is trusted, except
 * to drop a `stateLost` hold, which may guard a decline the set-aside file lost.
 */
export function wslMoveDistroMappedDrivesLastKnown(
  store: Pick<Store, 'getRepos' | 'getFolderWorkspaces'>,
  distro: string,
  check: WslMoveInUseCheck = {}
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
    if (letter === windowsSystemDriveLetter()) {
      continue
    }
    const known = wslMappedDriveLastKnownShare(letter)
    if (known?.share) {
      if (wslMappedDriveMatches(known.share, distro, undefined)) {
        mapped.push({ letter, share: known.share })
      }
      continue
    }
    if (!known || known.lookup === 'failed' || (!known.lookup && check.droppingLostHold)) {
      return 'unverifiable'
    }
  }
  return mapped
}
