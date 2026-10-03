import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import {
  createGitObjectQuarantine,
  inheritedObjectStore,
  pathApiForGitPath,
  type GitObjectQuarantineEnv,
  type GitObjectsDirectory
} from '../../shared/git-object-quarantine'
import { addWslEnvKeys } from '../../shared/wsl-env'
import { toLinuxPath, toWindowsWslPath } from '../../shared/wsl-paths'
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
    wslDistro && !isWindowsAbsolutePathLike(commonDir)
      ? toWindowsWslPath(commonDir, wslDistro)
      : commonDir
  // Why: Git < 2.31 prints a relative common dir, resolved against a `C:\` repo path; WSL Git needs `/mnt/c`.
  const gitCommonDir = wslDistro ? toLinuxPath(commonDir) : commonDir
  return {
    hostPath: pathApiForGitPath(hostCommonDir).join(hostCommonDir, 'objects'),
    gitPath: pathApiForGitPath(gitCommonDir).join(gitCommonDir, 'objects')
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

const OBJECT_STORE_VARIABLES = ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']

/** The object-store variables local Git would inherit, or undefined when they cannot be mirrored. */
export function inheritedLocalObjectStore(
  wslDistro: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Pick<GitObjectsDirectory, 'inheritedAlternates'> | undefined {
  if (platform !== 'win32' || !wslDistro) {
    return inheritedObjectStore(env)
  }
  // Why: wsl.exe forwards only what WSLENV names, maybe path-translated (`/p`); skip rather than guess.
  const forwarded = new Set((env.WSLENV ?? '').split(':').map((token) => token.split('/')[0]))
  return OBJECT_STORE_VARIABLES.some((key) => forwarded.has(key) && env[key] !== undefined)
    ? undefined
    : {}
}

/** Scratch object store for throwaway Git writes on the local (native or WSL) host. */
export function createLocalGitObjectQuarantine(
  repoPath: string,
  options: { wslDistro?: string; signal?: AbortSignal; admissionTier?: GitAdmissionTier } = {}
): LocalGitObjectQuarantine {
  const wslDistro = parseWslPath(repoPath)?.distro ?? options.wslDistro
  const quarantine = createGitObjectQuarantine(async () => {
    const inherited = inheritedLocalObjectStore(wslDistro)
    if (!inherited) {
      return undefined
    }
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
    return { ...localGitObjectsDirectory(commonDir, wslDistro), ...inherited }
  })
  return {
    run: (command) =>
      quarantine.run((env) => command(env ? localGitObjectQuarantineProcessEnv(env) : undefined))
  }
}
