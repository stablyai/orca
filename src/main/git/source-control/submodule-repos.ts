import { realpath, stat } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitSubmoduleRepo } from '../../../shared/git-submodule-repo-types'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { getUpstreamStatus } from '../upstream'
import { listSubmodulePaths, resolveSubmoduleWorktreePath } from './submodule-paths'

const SUBMODULE_REPO_READ_CONCURRENCY = 4

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * Resolve a submodule the parent lists in .gitmodules and has checked out. Anything else is
 * refused, so a renderer cannot point a git action at an arbitrary folder.
 */
export async function resolveInitializedSubmodulePath(
  parentWorktreePath: string,
  submodulePath: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  const normalized = submodulePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const listed = await listSubmodulePaths(parentWorktreePath, options)
  if (!listed.includes(normalized)) {
    throw new Error('Access denied: path is not a submodule of this worktree')
  }
  const resolved = resolveSubmoduleWorktreePath(parentWorktreePath, normalized)
  // A symlinked submodule folder must not lead outside the worktree.
  const [realParent, realChild] = await Promise.all([
    realpath(parentWorktreePath),
    realpath(resolved).catch(() => null)
  ])
  if (!realChild || !isInside(realParent, realChild)) {
    throw new Error('Access denied: submodule path escapes the selected worktree')
  }
  // An uninitialized submodule is an empty folder inside the parent's own repo.
  const gitEntry = await stat(path.join(resolved, '.git')).catch(() => null)
  if (!gitEntry) {
    throw new Error('Submodule is not initialized')
  }
  return resolved
}

async function readBranch(
  submoduleWorktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(['symbolic-ref', '--short', '-q', 'HEAD'], {
      ...gitOptionsForWorktree(submoduleWorktreePath, options),
      env: gitOptionalLocksDisabledEnv()
    })
    return stdout.trim() || null
  } catch {
    // Exit 1 means detached HEAD.
    return null
  }
}

/** List initialized submodules with branch and ahead/behind; uninitialized ones are left out. */
export async function listSubmoduleRepos(
  parentWorktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitSubmoduleRepo[]> {
  const listed = await listSubmodulePaths(parentWorktreePath, options)
  const repos = await mapWithConcurrency(
    [...new Set(listed)].sort(),
    SUBMODULE_REPO_READ_CONCURRENCY,
    async (submodulePath): Promise<GitSubmoduleRepo | null> => {
      let resolved: string
      try {
        resolved = await resolveInitializedSubmodulePath(parentWorktreePath, submodulePath, options)
      } catch {
        return null
      }
      const branch = await readBranch(resolved, options)
      const upstream = branch
        ? await getUpstreamStatus(resolved, undefined, options)
            .then(({ hasUpstream, upstreamName, ahead, behind }) => ({
              hasUpstream,
              upstreamName,
              ahead,
              behind
            }))
            .catch(() => null)
        : null
      return { path: submodulePath, branch, upstream }
    }
  )
  return repos.filter((repo): repo is GitSubmoduleRepo => repo !== null)
}
