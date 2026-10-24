/**
 * A brand-new project on a Windows drive (`C:\…`) added while the global default runtime is WSL
 * gets Git for Windows, keeping its terminals and agents in WSL: WSL Git there is ~300x slower and
 * misses Windows-side edits. Existing projects convert through wsl-drive-project-windows-git.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  normalizeGlobalWindowsRuntimeDefault,
  type LocalWindowsRuntimePreference
} from '../../shared/project-execution-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Project } from '../../shared/project-types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { wslHostsGateOpen } from './wsl-host-gate'

export type NewWindowsDriveProjectDefaultArgs = {
  platform: string
  repo: Pick<Repo, 'path' | 'kind' | 'executionHostId' | 'connectionId'>
  globalWindowsRuntimeDefault: unknown
  /** `gitdir` links of the repo's linked worktrees; null when they can't be read. */
  readWorktreeLinks: (repoPath: string) => string[] | null
}

export function newWindowsDriveProjectRuntimePreference(
  args: NewWindowsDriveProjectDefaultArgs
): LocalWindowsRuntimePreference | null {
  const { repo } = args
  if (
    args.platform !== 'win32' ||
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    isFolderRepo(repo) ||
    !/^[A-Za-z]:[\\/]/.test(repo.path)
  ) {
    return null
  }
  const globalDefault = normalizeGlobalWindowsRuntimeDefault(args.globalWindowsRuntimeDefault)
  if (globalDefault.kind !== 'wsl' || !globalDefault.distro) {
    return null
  }
  // WSL Git wrote Linux-path links that Windows Git can't follow; the preflight refuses these too.
  const links = args.readWorktreeLinks(repo.path)
  if (!links || links.some((link) => link.startsWith('/'))) {
    return null
  }
  // Pinned like a converted project, so a later global change can't silently switch its Git.
  return { kind: 'wsl', distro: globalDefault.distro, git: 'windows-host' }
}

/** Sets the default on the project `addRepo` just made for `repo`; true when it wrote. */
export function applyNewWindowsDriveProjectDefault(
  state: {
    projects: Pick<Project, 'sourceRepoIds' | 'localWindowsRuntimePreference'>[]
    settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>
  },
  repo: NewWindowsDriveProjectDefaultArgs['repo'] & Pick<Repo, 'id'>,
  env: Pick<NewWindowsDriveProjectDefaultArgs, 'platform' | 'readWorktreeLinks'> = {
    platform: process.platform,
    readWorktreeLinks: readMainCheckoutWorktreeLinks
  }
): boolean {
  if (!wslHostsGateOpen()) {
    return false
  }
  const project = state.projects.find((entry) => entry.sourceRepoIds.includes(repo.id))
  if (!project || project.localWindowsRuntimePreference) {
    return false
  }
  const preference = newWindowsDriveProjectRuntimePreference({
    ...env,
    repo,
    globalWindowsRuntimeDefault: state.settings.localWindowsRuntimeDefault
  })
  if (!preference) {
    return false
  }
  project.localWindowsRuntimePreference = preference
  return true
}

/** Only a main checkout's `.git` folder; a linked worktree or submodule reads as unknown. */
export function readMainCheckoutWorktreeLinks(repoPath: string): string[] | null {
  try {
    const gitDir = join(repoPath, '.git')
    if (!statSync(gitDir).isDirectory()) {
      return null
    }
    const root = join(gitDir, 'worktrees')
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      return []
    }
    return names.flatMap((name) => {
      try {
        return [readFileSync(join(root, name, 'gitdir'), 'utf8').trim()]
      } catch {
        return []
      }
    })
  } catch {
    return null
  }
}
