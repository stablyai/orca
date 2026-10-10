import { buildExcludePathPrefixes } from '../../shared/quick-open-filter'
import type { Store } from '../persistence'
import { parseWslPath } from '../wsl'
import { resolveAuthorizedPath } from './filesystem-auth'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'

export type QuickOpenSearchRoot = {
  authorizedRootPath: string
  localGitOptions: ReturnType<typeof getLocalGitOptionsForRegisteredWorktree>
  excludePathPrefixes: string[]
  wslDistroForOutput: string | undefined
}

/** The authorized root, its git options and nested-worktree excludes for quick-open scans. */
export async function resolveQuickOpenSearchRoot(
  rootPath: string,
  store: Store,
  excludePaths: string[] | undefined
): Promise<QuickOpenSearchRoot> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
    store,
    rootPath,
    authorizedRootPath
  )

  // Why: when the main worktree sits at the repo root, linked worktrees are
  // nested subdirectories. Without excluding them, rg/git lists files from
  // every worktree instead of just the active one. The shared helper
  // normalizes, validates, and root-relativizes every input.
  const excludePathPrefixes = [
    ...new Set([
      ...buildExcludePathPrefixes(rootPath, excludePaths),
      ...buildExcludePathPrefixes(authorizedRootPath, excludePaths)
    ])
  ]
  return {
    authorizedRootPath,
    localGitOptions,
    excludePathPrefixes,
    wslDistroForOutput: parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro
  }
}
