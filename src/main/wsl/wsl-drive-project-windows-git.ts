/**
 * Converts a WSL-runtime project on a Windows drive (`C:\…`) to Windows Git, keeping its terminals
 * and agents in WSL. Paths, worktree ids, chats and live terminals are untouched; only where Orca
 * runs Git changes. Refused when Windows Git couldn't safely own the repo's worktrees.
 */
import { win32 } from 'node:path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { isWslUncPath } from '../../shared/wsl-paths'
import { isForeignLink } from '../git/worktree-prune-guard'
import type {
  WslDriveProjectConversionResult,
  WslDriveProjectPreview
} from '../../shared/wsl-drive-project-types'

/** Windows Git only: the runner never routes through WSL. */
export type WindowsGitRunner = (args: string[], cwd: string) => Promise<string>

export type WslDriveProjectDeps = {
  getProjects: () => readonly Project[]
  getRepos: () => readonly Repo[]
  resolveRuntime: (project: Project) => ProjectExecutionRuntimeResolution
  runWindowsGit: WindowsGitRunner
  /** The `gitdir` link of each linked worktree under `<commonDir>/worktrees`. */
  readWorktreeLinks: (commonDir: string) => Promise<string[]>
}

export async function previewWslDriveProjectWindowsGit(
  deps: WslDriveProjectDeps,
  projectId: string
): Promise<WslDriveProjectPreview> {
  const project = deps.getProjects().find((entry) => entry.id === projectId)
  if (!project) {
    throw new Error('wsl_drive_project_missing')
  }
  const preview: WslDriveProjectPreview = { projectId, distro: null, repos: [], blockers: [] }
  const runtime = deps.resolveRuntime(project)
  if (runtime.status === 'repair-required') {
    preview.blockers.push({ kind: 'runtime-needs-repair' })
    return preview
  }
  if (runtime.runtime.kind !== 'wsl' || runtime.runtime.git === 'windows-host') {
    preview.blockers.push({ kind: 'not-wsl-runtime' })
    return preview
  }
  preview.distro = runtime.runtime.distro
  // Folder repos run no Git, so the Git choice never reaches them.
  const repos = deps
    .getRepos()
    .filter((repo) => project.sourceRepoIds.includes(repo.id) && !isFolderRepo(repo))
  for (const repo of repos) {
    if (
      getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
      !isWindowsDrivePath(repo.path)
    ) {
      preview.blockers.push({ kind: 'not-windows-drive', repoId: repo.id })
      continue
    }
    if (repo.worktreeBasePath && isWslUncPath(repo.worktreeBasePath)) {
      preview.blockers.push({ kind: 'worktree-folder-in-distro', repoId: repo.id })
    }
  }
  if (preview.blockers.length > 0) {
    return preview
  }
  if (!(await windowsGitAvailable(deps.runWindowsGit, repos[0]?.path))) {
    preview.blockers.push({ kind: 'windows-git-missing' })
    return preview
  }
  for (const repo of repos) {
    const wslAuthored = await wslAuthoredWorktreePaths(deps, repo.path)
    if (wslAuthored.length > 0) {
      preview.blockers.push({ kind: 'wsl-authored-worktrees', repoId: repo.id, paths: wslAuthored })
    }
    preview.repos.push({
      repoId: repo.id,
      path: repo.path,
      windowsAutocrlf: await readConfig(deps.runWindowsGit, repo.path, []),
      localAutocrlf: await readConfig(deps.runWindowsGit, repo.path, ['--local'])
    })
  }
  return preview
}

/**
 * `alignLineEndings` writes Windows Git's `core.autocrlf=true` into the repo, so plain WSL Git in
 * the project's terminals stops seeing every file as modified and committing CRLF. Opt-in: it
 * writes to the user's repo. Never `core.checkStat`, which hides same-size edits from Windows Git.
 */
export async function convertWslDriveProjectToWindowsGit(
  deps: WslDriveProjectDeps,
  projectId: string,
  options: { alignLineEndings: boolean }
): Promise<WslDriveProjectConversionResult> {
  const preview = await previewWslDriveProjectWindowsGit(deps, projectId)
  if (preview.blockers.length > 0 || !preview.distro) {
    return { ok: false, blockers: preview.blockers }
  }
  const alignedLineEndingRepoIds: string[] = []
  if (options.alignLineEndings) {
    for (const repo of preview.repos) {
      if (repo.windowsAutocrlf === 'true' && repo.localAutocrlf === null) {
        await deps.runWindowsGit(['config', '--local', 'core.autocrlf', 'true'], repo.path)
        alignedLineEndingRepoIds.push(repo.repoId)
      }
    }
  }
  return {
    ok: true,
    preference: { kind: 'wsl', distro: preview.distro, git: 'windows-host' },
    alignedLineEndingRepoIds
  }
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

export async function windowsGitAvailable(
  run: WindowsGitRunner,
  cwd: string | undefined
): Promise<boolean> {
  if (!cwd) {
    return true
  }
  try {
    await run(['--version'], cwd)
    return true
  } catch {
    return false
  }
}

/**
 * Linked worktrees whose recorded link is a Linux path, i.e. WSL Git wrote it. Read from the link
 * files themselves: Windows Git may print a Linux path as a drive path under the current drive.
 */
export async function wslAuthoredWorktreePaths(
  deps: Pick<WslDriveProjectDeps, 'runWindowsGit' | 'readWorktreeLinks'>,
  repoPath: string
): Promise<string[]> {
  const commonDir = (await deps.runWindowsGit(['rev-parse', '--git-common-dir'], repoPath)).trim()
  const links = await deps.readWorktreeLinks(win32.resolve(repoPath, commonDir))
  return links
    .filter((link) => isForeignLink(link, false))
    .map((link) => link.replace(/\/\.git$/, ''))
}

async function readConfig(
  run: WindowsGitRunner,
  repoPath: string,
  scope: string[]
): Promise<string | null> {
  try {
    const value = (await run(['config', ...scope, '--get', 'core.autocrlf'], repoPath)).trim()
    return value || null
  } catch {
    // Exit 1 means unset.
    return null
  }
}
