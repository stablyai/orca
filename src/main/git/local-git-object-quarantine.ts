import { mkdtemp, rm } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import {
  createGitObjectQuarantine,
  type GitObjectQuarantineEnv,
  type GitObjectsDirectory
} from '../../shared/git-object-quarantine'
import { addWslEnvKeys } from '../../shared/wsl-env'
import { isWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { parseWslPath } from '../wsl'
import { usesHostGitForWslLinkedWorktree } from './wsl-linked-worktree-git-routing'
import { readRepoCommonDirFromGit } from './worktree-list-reader'

export type LocalGitObjectQuarantine = {
  /** `env` is a full process env for `gitExecFileAsync`, or undefined to run unquarantined. */
  run: <T>(command: (env: NodeJS.ProcessEnv | undefined) => Promise<T>) => Promise<T>
}

/** `objects/` in Git's spelling and, for WSL Git, translated to one the main process can open. */
export function localGitObjectsDirectory(
  commonDir: string,
  wslDistro: string | undefined
): GitObjectsDirectory {
  const hostCommonDir =
    wslDistro && !isWslUncPath(commonDir) && !isWindowsAbsolutePathLike(commonDir)
      ? toWindowsWslPath(commonDir, wslDistro)
      : commonDir
  // Decided by path syntax, not by platform: a Windows main process drives WSL Git.
  const pathApiFor = (value: string): typeof posix =>
    isWindowsAbsolutePathLike(value) ? win32 : posix
  return {
    hostPath: pathApiFor(hostCommonDir).join(hostCommonDir, 'objects'),
    gitPath: pathApiFor(commonDir).join(commonDir, 'objects')
  }
}

export function localGitObjectQuarantineProcessEnv(
  quarantine: GitObjectQuarantineEnv,
  platform: NodeJS.Platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...quarantine }
  if (platform === 'win32') {
    // Why: wsl.exe forwards only WSLENV-named vars; the values are already Linux paths, so no `/p`.
    addWslEnvKeys(env, ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'])
  }
  return env
}

/** Scratch object store for throwaway Git writes on the local (native or WSL) host. */
export function createLocalGitObjectQuarantine(
  repoPath: string,
  options: { wslDistro?: string; signal?: AbortSignal; admissionTier?: GitAdmissionTier } = {}
): LocalGitObjectQuarantine {
  const wslDistro = parseWslPath(repoPath)?.distro ?? options.wslDistro
  const quarantine = createGitObjectQuarantine({
    async resolveObjectsDirectory() {
      const commonDir = await readRepoCommonDirFromGit(repoPath, {
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
      })
      // Why after the read: that first Git call is what settles the WSL linked-worktree route,
      // and Windows Git on that route may not share the spelling resolved above.
      if (!commonDir || usesHostGitForWslLinkedWorktree(repoPath, options.wslDistro)) {
        return undefined
      }
      return localGitObjectsDirectory(commonDir, wslDistro)
    },
    makeTempDirectory: (prefix) => mkdtemp(prefix),
    removeDirectory: (hostPath) => rm(hostPath, { recursive: true, force: true })
  })
  return {
    run: (command) =>
      quarantine.run((env) => command(env ? localGitObjectQuarantineProcessEnv(env) : undefined))
  }
}
