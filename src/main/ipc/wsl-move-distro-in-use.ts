/** Whether the move orchestrator still has a reason to keep a distro's record (D3a-2 pruning). */
import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import { wslMoveJournalKey } from '../../shared/wsl-move/wsl-move-cutover'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { Store } from '../persistence'
import {
  isLocalWslMoveRow,
  wslMoveHostDistro
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { defaultWslOrcadEnvironmentId } from '../wsl/wsl-orcad-deploy'

/**
 * A bridge project of the distro (local, on its UNC path, not moved) or its WSL host record. A
 * host file that cannot be read counts as in use: a failed read never makes a distro look gone.
 */
export function isDistroInUse(
  store: Pick<Store, 'getRepos' | 'getFolderWorkspaces'>,
  userDataPath: string,
  distro: string
): boolean {
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  try {
    const hosts = readWslHostDeployments(userDataPath)
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
  const onDistro = (path: string): boolean => {
    const unc = parseWslUncPath(path)
    return unc !== null && wslMoveJournalKey(unc.distro) === key
  }
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
