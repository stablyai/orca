import { stat } from 'fs/promises'
import { join } from 'path'
import {
  JUJUTSU_BIN,
  buildJjRemoteListArgs,
  buildJjWorkspaceAddArgs,
  buildJjWorkspaceForgetArgs,
  buildJjWorkspaceListArgs,
  buildJjWorkspaceListDefaultArgs,
  buildJjWorkspaceRootArgs,
  jujutsuWorkspaceNameForPath,
  parseJujutsuRemoteNames,
  parseJujutsuWorkspaceList,
  parseJujutsuWorkspaceListDefault,
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

// List the repo's jj remote names. Best-effort: returns [] when jj is
// unavailable or the repo has no git backend, so base-ref resolution simply
// declines to rewrite slash-containing refs.
export async function listJujutsuRemotes(
  repoPath: string,
  options: JujutsuExecOptions = {}
): Promise<string[]> {
  try {
    const { stdout } = await commandExecFileAsync(JUJUTSU_BIN, buildJjRemoteListArgs(), {
      cwd: repoPath,
      ...options
    })
    return parseJujutsuRemoteNames(stdout)
  } catch {
    return []
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
// own default) and the git base ref is translated to a jj revset, but only a
// `<remote>/<branch>` ref whose prefix is a real jj remote is rewritten — local
// bookmarks like `feature/foo` are passed through untouched.
export async function addJujutsuWorkspace(
  input: AddJujutsuWorkspaceInput,
  options: JujutsuExecOptions = {}
): Promise<void> {
  // Only pay for the remote lookup when the ref could be remote-tracking.
  const knownRemotes = input.baseRef?.includes('/')
    ? await listJujutsuRemotes(input.repoPath, options)
    : []
  const args = buildJjWorkspaceAddArgs({
    worktreePath: input.worktreePath,
    name: input.name ?? jujutsuWorkspaceNameForPath(input.worktreePath),
    baseRevision: resolveJujutsuBaseRevision(input.baseRef, knownRemotes)
  })
  await commandExecFileAsync(JUJUTSU_BIN, args, { cwd: input.repoPath, ...options })
}

// List workspaces with their paths, falling back to the template-less format on
// jj < 0.32 (which rejects `--template`); the fallback yields names with empty
// paths.
export async function listJujutsuWorkspaces(
  repoPath: string,
  options: JujutsuExecOptions = {}
): Promise<JujutsuWorkspaceInfo[]> {
  try {
    const { stdout } = await commandExecFileAsync(JUJUTSU_BIN, buildJjWorkspaceListArgs(), {
      cwd: repoPath,
      ...options
    })
    return parseJujutsuWorkspaceList(stdout)
  } catch (error) {
    if (!isUnsupportedTemplateError(error)) {
      throw error
    }
    const { stdout } = await commandExecFileAsync(JUJUTSU_BIN, buildJjWorkspaceListDefaultArgs(), {
      cwd: repoPath,
      ...options
    })
    return parseJujutsuWorkspaceListDefault(stdout)
  }
}

// jj < 0.32 rejects `--template` on `workspace list`; detect that (and a stale
// `root()` method on in-between versions) to trigger the name-only fallback
// without masking unrelated failures.
function isUnsupportedTemplateError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${(error as { stderr?: string }).stderr ?? ''}`
      : String(error)
  return /unexpected argument|--template|unrecognized|no method named `root`|root\(\)/i.test(text)
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
