import type { GitExecutionContext } from '../command-runner/host-routing/wsl-git-path-preparation'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/source-control/git-admission-tier-params'
import {
  createGitObjectQuarantine,
  inheritedObjectStore,
  pathApiForGitPath,
  type GitObjectsDirectory
} from '../../../shared/git/objects/git-object-quarantine'
import { toWindowsWslUncPath } from '../../../shared/wsl-paths'
import {
  type WslAutomountSnapshot,
  isWslAutomountSnapshotCurrent,
  peekWslAutomountRoot
} from '../../wsl/filesystem/wsl-automount-root'
import {
  isWindowsDrivePath,
  windowsDrivePathForDistro,
  wslDrivePathForDistro
} from '../../wsl/filesystem/wsl-drive-paths'
import { parseWslPath } from '../../wsl/filesystem/unc-path-access'
import { usesHostGitForWslLinkedWorktree } from '../command-runner/host-routing/wsl-linked-worktree-git-routing'
import { readRepoCommonDirWithContext } from '../worktrees/catalog/worktree-list-reader'

export type LocalGitObjectQuarantine = {
  /** `env` is a full process env for `gitExecFileAsync`, or undefined to run unquarantined. */
  run: <T>(
    command: (
      env: NodeJS.ProcessEnv | undefined,
      canStart?: (context?: GitExecutionContext) => boolean
    ) => Promise<T>
  ) => Promise<T>
}

/** `objects/` in Git's spelling and, for WSL Git, translated to one the main process can open. */
export function localGitObjectsDirectory(
  commonDir: string,
  wslDistro: string | undefined,
  snapshot?: WslAutomountSnapshot
): GitObjectsDirectory {
  const hostCommonDir =
    wslDistro && !isWindowsAbsolutePathLike(commonDir)
      ? (((snapshot ? snapshot.root : peekWslAutomountRoot(wslDistro)) === null
          ? null
          : windowsDrivePathForDistro(commonDir, wslDistro, snapshot)) ??
        toWindowsWslUncPath(commonDir, wslDistro))
      : commonDir
  // Older Git returns a relative common dir resolved against the host's repo path.
  const gitCommonDir = wslDistro
    ? (parseWslPath(commonDir)?.linuxPath ??
      wslDrivePathForDistro(commonDir, wslDistro, snapshot) ??
      commonDir)
    : commonDir
  return {
    hostPath: pathApiForGitPath(hostCommonDir).join(hostCommonDir, 'objects'),
    gitPath: pathApiForGitPath(gitCommonDir).join(gitCommonDir, 'objects')
  }
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
  options: {
    wslDistro?: string
    signal?: AbortSignal
    admissionTier?: GitAdmissionTier
    spawnOnWorkerThread?: boolean
  } = {}
): LocalGitObjectQuarantine {
  let authority: GitExecutionContext | undefined
  const invalidQuarantine = new Error(
    'The temporary Git object store belongs to an obsolete execution context.'
  )
  const current = (): boolean =>
    authority?.kind !== 'wsl' || isWslAutomountSnapshotCurrent(authority.paths)
  const validate = (context?: GitExecutionContext): boolean => {
    options.signal?.throwIfAborted()
    if (
      !current() ||
      !authority ||
      !context ||
      authority.kind !== context.kind ||
      (authority.kind === 'wsl' &&
        context.kind === 'wsl' &&
        authority.paths.distro.toLowerCase() !== context.paths.distro.toLowerCase())
    ) {
      throw invalidQuarantine
    }
    return true
  }
  const quarantine = createGitObjectQuarantine(async () => {
    const result = await readRepoCommonDirWithContext(repoPath, {
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.spawnOnWorkerThread ? { spawnOnWorkerThread: true } : {}),
      ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
    })
    // Probe first to settle linked-worktree routing; host Git may need a different object-store spelling.
    if (
      !result?.executionContext ||
      (result.executionContext.kind === 'host' &&
        usesHostGitForWslLinkedWorktree(repoPath, options.wslDistro))
    ) {
      return undefined
    }
    authority = result.executionContext
    const paths = authority?.kind === 'wsl' ? authority.paths : undefined
    const wslDistro = paths?.distro
    const inherited = inheritedLocalObjectStore(wslDistro)
    if (!inherited || !current()) {
      return undefined
    }
    if (wslDistro && isWindowsDrivePath(result.path) && !paths?.root) {
      return undefined
    }
    return { ...localGitObjectsDirectory(result.path, wslDistro, paths), ...inherited }
  })
  return {
    async run(command) {
      if (authority && !current()) {
        return command(undefined)
      }
      try {
        return await quarantine.run((env) => {
          options.signal?.throwIfAborted()
          if (env && !current()) {
            throw invalidQuarantine
          }
          return command(env ? { ...process.env, ...env } : undefined, env ? validate : undefined)
        })
      } catch (error) {
        if (error !== invalidQuarantine) {
          throw error
        }
        options.signal?.throwIfAborted()
        return command(undefined)
      }
    }
  }
}
