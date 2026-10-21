import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { isFolderRepo } from '../../shared/repo-kind'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'
import { buildKnownOrcaWorkspaceLayouts } from '../../shared/worktree/ownership'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'

type ScopeRepo = SessionSearchScopeCatalog['repos'][number]

/** Absolute paths in insertion order, deduplicated by the comparison key. */
export class ScopePathSet {
  private readonly seen = new Set<string>()
  private readonly entries: string[] = []

  add(value: string | null | undefined): void {
    const trimmed = value?.trim()
    if (!trimmed || !isRuntimePathAbsolute(trimmed)) {
      return
    }
    const key = normalizeRuntimePathForComparison(trimmed)
    if (this.seen.has(key)) {
      return
    }
    this.seen.add(key)
    this.entries.push(trimmed)
  }

  // The index matches by prefix, so a contained path is one more SQL range for
  // no extra rows.
  folded(): string[] {
    return this.entries.filter(
      (candidate) =>
        !this.entries.some((other) => other !== candidate && isPathInsideOrEqual(other, candidate))
    )
  }
}

/**
 * The directories Orca creates this repo's worktrees in, past and present, where
 * such a directory belongs to this repo alone.
 *
 * A global root counts only under nesting: flat placement makes it every
 * project's, and claiming it would widen a project search to the whole machine.
 * An empty result costs only the folding — every registered worktree is still listed.
 */
export function managedWorktreeDirectories(
  repo: ScopeRepo,
  settings: SessionSearchScopeCatalog['settings']
): string[] {
  if (isFolderRepo(repo)) {
    return []
  }
  const configured = new Set(
    resolveConfiguredWorktreeBasePaths(repo).map(normalizeRuntimePathForComparison)
  )
  const repoName = getRuntimePathBasename(repo.path).replace(/\.git$/, '')
  const directories: string[] = []
  for (const layout of buildKnownOrcaWorkspaceLayouts(settings, repo)) {
    if (configured.has(normalizeRuntimePathForComparison(layout.path))) {
      directories.push(layout.path)
    } else if (layout.nestWorkspaces && repoName) {
      directories.push(resolveRuntimePath(layout.path, repoName))
    }
  }
  return directories
}
