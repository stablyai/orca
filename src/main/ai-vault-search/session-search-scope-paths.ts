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

  // Prefix matching makes contained paths redundant SQL ranges.
  folded(): string[] {
    return this.entries.filter(
      (candidate) =>
        !this.entries.some((other) => other !== candidate && isPathInsideOrEqual(other, candidate))
    )
  }
}

/** Flat global roots belong to all projects; only repo-specific directories can narrow scope. */
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
