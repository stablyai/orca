import { realpath, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveGitCommonDirectory } from '../../shared/git/metadata/git-common-directory'
import { resolveWorktreeHostPath } from '../../shared/git/metadata/git-metadata-path'
import { gitRepositoryPathKey } from '../../shared/git/metadata/git-repository-path-key'
import { wslDistroForCommand } from '../../shared/wsl-paths'
import { routeLocalGitOptions } from './command-runner/host-routing/local-git-runtime-route'
import { prepareWslLinkedWorktreeGitRouting } from './command-runner/host-routing/wsl-linked-worktree-git-routing'
import { blockedWslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import type { LocalGitExecOptions } from './repo-default-base-ref'
import { resolveGitDir } from './source-control/resolve-git-dir'

export type BranchSnapshotIdentity = {
  key: string
  commonDir: string
  gitDir: string
  checkoutKey: string
  cwd: string
  git: LocalGitExecOptions
}

export async function resolveBranchSnapshotIdentity(
  cwd: string,
  git: LocalGitExecOptions
): Promise<BranchSnapshotIdentity | null> {
  const routed = routeLocalGitOptions({ cwd, ...git })
  if (await blockedWslDistroForPath(cwd, routed.wslDistro)) {
    throw new Error('The project Git runtime is not running')
  }
  const distro = (await prepareWslLinkedWorktreeGitRouting(cwd, routed.wslDistro))
    ? null
    : wslDistroForCommand(cwd, routed.wslDistro)
  const runtime = distro ? `wsl:${distro.toLowerCase()}` : 'host'
  let hostRoot = await realpath(resolveWorktreeHostPath(cwd, routed) ?? cwd)
  let commonDir = await resolveGitCommonDirectory(hostRoot, routed)
  while (!commonDir) {
    const parent = dirname(hostRoot)
    if (parent === hostRoot) {
      return null
    }
    hostRoot = parent
    commonDir = await resolveGitCommonDirectory(hostRoot, routed)
  }
  const physicalCommonDir = await realpath(commonDir)
  const commonStat = await stat(physicalCommonDir, { bigint: true })
  const checkoutGitDir = await resolveGitDir(hostRoot, routed)
  const gitDir = await stat(checkoutGitDir).then(
    (entry) => (entry.isDirectory() ? checkoutGitDir : commonDir),
    () => commonDir
  )
  const physicalGitDir = await realpath(gitDir)
  const checkoutStat = await stat(physicalGitDir, { bigint: true })
  return {
    key: `${runtime}\0${gitRepositoryPathKey(physicalCommonDir)}\0${commonStat.dev}:${commonStat.ino}:${commonStat.birthtimeNs}`,
    commonDir: physicalCommonDir,
    gitDir: physicalGitDir,
    checkoutKey: `${gitRepositoryPathKey(physicalGitDir)}\0${checkoutStat.dev}:${checkoutStat.ino}:${checkoutStat.birthtimeNs}`,
    cwd,
    git: routed
  }
}
