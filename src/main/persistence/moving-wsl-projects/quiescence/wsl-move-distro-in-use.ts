/** Whether the move orchestrator still has a reason to keep a distro's record (D3a-2 pruning). */
import { readWslHostDeployments } from '../../../../shared/remote-runtime/host-store/runtime-environment-registry'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import {
  toWslDistroUncPath,
  type WslMappedDrive
} from '../../../../shared/wsl-move/wsl-mapped-drive-paths'
import type { Store } from '../../loading-store/store'
import { isLocalWslMoveRow, wslMoveHostDistro } from './wsl-move-scope-guard'
import { defaultWslOrcadEnvironmentId } from '../../../wsl/orcad/wsl-orcad-deploy'

/**
 * A bridge project of the distro (local, on its UNC path or a drive mapped into it, not moved) or
 * its WSL host record. A host file that cannot be read counts as in use: a failed read never makes
 * a distro look gone. Mapped drives come from last-known answers only: this runs in the
 * background, where reading a share can boot its stopped distro. Unknown counts as in use.
 */
export async function isDistroInUse(
  store: Pick<Store, 'getRepos' | 'getFolderWorkspaces'>,
  userDataPath: string,
  distro: string,
  lastKnownMappedDrives?: () => readonly WslMappedDrive[] | 'unverifiable'
): Promise<boolean> {
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  try {
    const hosts = await readWslHostDeployments(userDataPath)
    if (
      hosts.unreadableEnvironmentIds.has(environmentId) ||
      hosts.deployments.some((record) => record.environmentId === environmentId)
    ) {
      return true
    }
  } catch {
    // A host file that cannot be read never makes a distro look gone.
    return true
  }
  const key = wslMoveJournalKey(distro)
  const hasBridgeProject = (mappedDrives: readonly WslMappedDrive[]): boolean =>
    hasUnmovedProjectIn(store, (path) => {
      const unc = parseWslUncPath(toWslDistroUncPath(path, mappedDrives))
      return unc !== null && wslMoveJournalKey(unc.distro) === key
    })
  const onUnc = hasBridgeProject([])
  if (onUnc || !lastKnownMappedDrives) {
    return onUnc
  }
  const mappedDrives = lastKnownMappedDrives()
  return mappedDrives === 'unverifiable' || hasBridgeProject(mappedDrives)
}

function hasUnmovedProjectIn(
  store: Pick<Store, 'getRepos' | 'getFolderWorkspaces'>,
  onDistro: (path: string) => boolean
): boolean {
  return (
    store
      .getRepos()
      .some(
        (repo) =>
          isLocalWslMoveRow(repo) &&
          onDistro(repo.path) &&
          wslMoveHostDistro({ repoId: repo.id }) === null
      ) ||
    store
      .getFolderWorkspaces()
      .some(
        (folder) =>
          isLocalWslMoveRow(folder) &&
          onDistro(folder.folderPath) &&
          wslMoveHostDistro({ folderWorkspaceId: folder.id }) === null
      )
  )
}
