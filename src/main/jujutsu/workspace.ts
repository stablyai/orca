import { stat } from 'fs/promises'
import { join } from 'path'
import {
  JUJUTSU_BIN,
  buildJjWorkspaceAddArgs,
  buildJjWorkspaceForgetArgs,
  buildJjWorkspaceListArgs,
  buildJjWorkspaceRootArgs,
  jujutsuWorkspaceNameForPath,
  parseJujutsuWorkspaceList,
  resolveJujutsuBaseRevision,
  type JujutsuWorkspaceInfo
} from '../../shared/jujutsu-workspace-command'
import { commandExecFileAsync } from '../git/runner'

export type JujutsuExecOptions = {
  env?: NodeJS.ProcessEnv
  timeout?: number
  signal?: AbortSignal
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// A jj repo is identified by a `.jj` directory at the workspace root — the same
// ancestor-marker scheme jj uses internally. No `jj` binary required, so
// detection works even when jj is not installed.
export async function isJujutsuRepo(repoPath: string): Promise<boolean> {
  return isDirectory(join(repoPath, '.jj'))
}

// Colocated repos carry both `.jj` and `.git`. Orca already drives those
// through its git machinery (status, diff, history, worktrees), so they must
// stay on git to avoid regressions.
export async function isColocatedJujutsuRepo(repoPath: string): Promise<boolean> {
  const [jj, git] = await Promise.all([
    isDirectory(join(repoPath, '.jj')),
    pathExists(join(repoPath, '.git'))
  ])
  return jj && git
}

// Sessions should spawn as `jj workspace` only for a pure-jj repo (a `.jj`
// marker with no colocated `.git`). Colocated repos keep using git worktrees so
// their existing status/diff/history flows stay intact — jj workspaces are not
// git worktrees and git tooling cannot see them (jj-vcs/jj#8052).
export async function shouldUseJujutsuWorkspace(repoPath: string): Promise<boolean> {
  const [jj, git] = await Promise.all([
    isDirectory(join(repoPath, '.jj')),
    pathExists(join(repoPath, '.git'))
  ])
  return jj && !git
}

// Resolve the workspace root from any subdirectory. Returns null when jj is not
// installed or the path is not a jj repo, so callers can fall back to git.
export async function jujutsuWorkspaceRoot(
  repoPath: string,
  options: JujutsuExecOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await commandExecFileAsync(JUJUTSU_BIN, buildJjWorkspaceRootArgs(), {
      cwd: repoPath,
      ...options
    })
    const root = stdout.trim()
    return root.length > 0 ? root : null
  } catch {
    return null
  }
}

export type AddJujutsuWorkspaceInput = {
  repoPath: string
  worktreePath: string
  name?: string
  baseRef?: string
}

// Create a new jj workspace at `worktreePath` — the jj analogue of
// `git worktree add`. The name defaults to the leaf directory (matching jj's
// own default) and the git base ref is translated to a jj revset.
export async function addJujutsuWorkspace(
  input: AddJujutsuWorkspaceInput,
  options: JujutsuExecOptions = {}
): Promise<void> {
  const args = buildJjWorkspaceAddArgs({
    worktreePath: input.worktreePath,
    name: input.name ?? jujutsuWorkspaceNameForPath(input.worktreePath),
    baseRevision: resolveJujutsuBaseRevision(input.baseRef)
  })
  await commandExecFileAsync(JUJUTSU_BIN, args, { cwd: input.repoPath, ...options })
}

export async function listJujutsuWorkspaces(
  repoPath: string,
  options: JujutsuExecOptions = {}
): Promise<JujutsuWorkspaceInfo[]> {
  const { stdout } = await commandExecFileAsync(JUJUTSU_BIN, buildJjWorkspaceListArgs(), {
    cwd: repoPath,
    ...options
  })
  return parseJujutsuWorkspaceList(stdout)
}

// Detach a workspace from the repo. jj leaves the directory on disk, so callers
// remove it separately — the same two-step contract as forgetting plus
// deleting a git worktree.
export async function forgetJujutsuWorkspace(
  repoPath: string,
  name: string,
  options: JujutsuExecOptions = {}
): Promise<void> {
  await commandExecFileAsync(JUJUTSU_BIN, buildJjWorkspaceForgetArgs(name), {
    cwd: repoPath,
    ...options
  })
}
