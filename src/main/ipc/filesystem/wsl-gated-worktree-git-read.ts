import type { Store } from '../../persistence'
import type { LocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import {
  assertWslUncPathRunning,
  noteWslDistroWokenForPath,
  runAsWslUserAct,
  wslDistroForPath
} from '../../wsl/wsl-unc-access-gate'

/**
 * Resolves a registered worktree and runs its Git read, refusing first when that would boot a
 * stopped WSL distro (E9). `wake` marks a user act (opening a diff, Refresh) that may start it.
 */
export async function readWorktreeGitUnlessWslStopped<T>(
  store: Store,
  requestedPath: string,
  wake: boolean | undefined,
  read: (worktreePath: string, gitOptions: LocalProjectWorktreeGitOptions) => Promise<T>
): Promise<T> {
  const wakeDistro = wake
    ? wslDistroForPath(
        requestedPath,
        getLocalGitOptionsForRegisteredWorktree(store, requestedPath, requestedPath).wslDistro
      )
    : null
  const result = await runAsWslUserAct(wakeDistro, async () => {
    // Resolving the path realpaths a UNC root, which boots the distro on its own.
    await assertWslUncPathRunning(requestedPath)
    const worktreePath = await resolveRegisteredWorktreePath(requestedPath, store)
    const gitOptions = getLocalGitOptionsForRegisteredWorktree(store, requestedPath, worktreePath)
    await assertWslUncPathRunning(worktreePath, gitOptions.wslDistro)
    return read(worktreePath, gitOptions)
  })
  if (wakeDistro) {
    noteWslDistroWokenForPath(requestedPath, wakeDistro)
  }
  return result
}
