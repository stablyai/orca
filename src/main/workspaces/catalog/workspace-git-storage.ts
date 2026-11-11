import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { resolveGitRouteForHost } from '../../providers/execution-host-provider-dispatch'
import { getSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { isWslUserActFor } from '../../wsl/discovery/wsl-user-act-scope'
import { assertWslUncPathRunning, wslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'

export const BARE_WORKSPACE_LAUNCH_ERROR =
  'This folder contains Git storage, not checked-out files. Open a checkout to start a terminal or chat.'

export class BareWorkspaceTerminalLaunchError extends Error {
  constructor() {
    super(BARE_WORKSPACE_LAUNCH_ERROR)
  }
}

const rootProbes = new Map<string, Promise<boolean>>()

/** Only an authoritative graph or an explicit host Git answer establishes bare storage. */
export function workspaceRootIsBare(
  repo: Repo,
  root: string,
  options: { worktrees?: readonly GitWorktreeInfo[]; wslDistro?: string } = {}
): Promise<boolean> {
  if (isFolderRepo(repo)) {
    return Promise.resolve(false)
  }
  const known = options.worktrees?.find((row) => areWorktreePathsEqual(row.path, root))
  if (known && !known.isBare) {
    return Promise.resolve(false)
  }
  const hostId = getRepoExecutionHostId(repo)
  const distro = hostId === 'local' ? wslDistroForPath(root, options.wslDistro) : null
  const key = JSON.stringify([hostId, options.wslDistro, root, distro && isWslUserActFor(distro)])
  const pending = rootProbes.get(key)
  if (pending) {
    return pending
  }
  const probe = probeWorkspaceRoot()
    .catch(() => false)
    .finally(() => {
      if (rootProbes.get(key) === probe) {
        rootProbes.delete(key)
      }
    })
  rootProbes.set(key, probe)
  return probe

  async function probeWorkspaceRoot(): Promise<boolean> {
    const route = resolveGitRouteForHost(hostId)
    if (route.kind === 'runtime') {
      // A paired runtime owns its namespace and admits execution on its own host.
      return false
    }
    if (route.kind === 'ssh') {
      const connection = getSshConnectionManager()?.getConnection(route.connectionId)
      if (connection?.getState().status !== 'connected') {
        return false
      }
      const stdout = await execCommand(
        connection,
        `git -C ${quotePosixShell(root)} rev-parse --is-bare-repository`,
        { timeoutMs: 5000 }
      )
      return stdout.trim() === 'true'
    }
    await assertWslUncPathRunning(root, options.wslDistro)
    const { stdout } = await route
      .createProvider({ wslDistro: options.wslDistro })
      .exec(['rev-parse', '--is-bare-repository'], root, { timeoutMs: 5000 })
    return stdout.trim() === 'true'
  }
}
