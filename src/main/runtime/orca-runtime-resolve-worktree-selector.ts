// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from './orca-runtime-resolve-browser-network-execution-host-for-worktree'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { splitWorktreeIdForFilesystem, worktreeIdComparisonKey } from '../../shared/worktree/id'
import { branchSelectorMatches, runtimePathsEqual } from './runtime-worktree-path-identity'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../shared/execution-host'
import type {
  WorktreeLineageInput,
  WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'
import type { OrchestrationDb } from './orchestration/db'
import { resolveNestedWorkerMaxDepth } from '../../shared/nested-worker-depth'
import type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { areWorktreePathsEqual, mergeWorktree } from '../ipc/worktree-logic'

export class OrcaRuntimeWithResolveWorktreeSelector extends OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree {
  protected async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(selector)
    // Why only `id:`: every other selector kind is matched across the whole fleet, and their
    // `selector_ambiguous` contract is defined over all repos. Scoping those would silently pick a
    // winner where today they correctly refuse. An `id:` selector already names its repo.
    if (explicitWorktreeId && !this.hasFreshResolvedWorktreeCache()) {
      const scoped = await this.resolveExplicitWorktreeIdScoped(explicitWorktreeId)
      if (scoped) {
        return scoped
      }
    }
    const worktrees = await this.listResolvedWorktrees()
    let candidates: ResolvedWorktree[]

    if (selector === 'active') {
      throw new Error('selector_not_found')
    }

    if (selector.startsWith('identity:')) {
      const identityKey = selector.slice('identity:'.length)
      candidates = worktrees.filter((worktree) => worktree.identity?.key === identityKey)
    } else if (selector.startsWith('id:')) {
      const worktreeId = explicitWorktreeId ?? selector.slice(3)
      candidates = worktrees.filter((worktree) => worktree.id === worktreeId)
      if (candidates.length === 0) {
        const comparisonKey = worktreeIdComparisonKey(worktreeId)
        candidates = comparisonKey
          ? worktrees.filter((worktree) => worktreeIdComparisonKey(worktree.id) === comparisonKey)
          : candidates
      }
      if (candidates.length === 0) {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        const repo = parsed ? this.store?.getRepo(parsed.repoId) : null
        const fallback =
          repo?.connectionId && this.store?.getWorktreeMeta(worktreeId)
            ? this.buildResolvedWorktreeFromId(worktreeId)
            : null
        if (fallback !== null) {
          candidates = [fallback]
        }
      }
    } else if (selector.startsWith('path:')) {
      candidates = worktrees.filter((worktree) =>
        runtimePathsEqual(worktree.path, selector.slice(5))
      )
      if (candidates.length > 1) {
        const hostIds = new Set(
          candidates.map((worktree) => {
            const repo = this.store?.getRepo(worktree.repoId)
            return getWorktreeExecutionHostId(worktree, repo)
          })
        )
        // Why: duplicate registrations on one host describe one path; identical paths on different hosts do not.
        if (hostIds.size === 1) {
          candidates = [candidates[0]]
        }
      }
    } else if (selector.startsWith('branch:')) {
      const branchSelector = selector.slice(7)
      candidates = worktrees.filter((worktree) =>
        branchSelectorMatches(worktree.branch, branchSelector)
      )
    } else if (selector.startsWith('name:')) {
      // Keep display-name matching exact so duplicate names hit the same ambiguity path as other selectors.
      candidates = worktrees.filter((worktree) => worktree.displayName === selector.slice(5))
    } else if (selector.startsWith('issue:')) {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.linkedIssue !== null && String(worktree.linkedIssue) === selector.slice(6)
      )
    } else {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.id === selector ||
          runtimePathsEqual(worktree.path, selector) ||
          branchSelectorMatches(worktree.branch, selector)
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('selector_not_found')
  }

  protected resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput
  ): Promise<WorktreeLineageResolution> {
    return this.worktreeLineage.resolveCreate(input)
  }

  protected getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    return this._orchestrationDb
  }

  getNestedWorkerMaxDepth(): number {
    return resolveNestedWorkerMaxDepth({
      nestedWorkerMaxDepth: (
        this.store?.getSettings?.() as { nestedWorkerMaxDepth?: number } | undefined
      )?.nestedWorkerMaxDepth
    })
  }

  hydrateInferredWorktreeLineage(): Promise<void> {
    return this.worktreeLineage.hydrate()
  }

  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.worktreeLineage.listWorktreeLineage()
  }

  listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    return this.worktreeLineage.listWorkspaceLineage()
  }

  // Why: one selector grammar, so connection-scoped resolution can narrow the same
  // candidate set instead of reimplementing (and diverging from) the matching rules.
  protected selectReposBySelector(selector: string): Repo[] {
    const repos = this.store?.getRepos() ?? []
    if (selector.startsWith('id:')) {
      return repos.filter((repo) => repo.id === selector.slice(3))
    }
    if (selector.startsWith('path:')) {
      return repos.filter((repo) => runtimePathsEqual(repo.path, selector.slice(5)))
    }
    if (selector.startsWith('name:')) {
      return repos.filter((repo) => repo.displayName === selector.slice(5))
    }
    return repos.filter(
      (repo) =>
        repo.id === selector ||
        runtimePathsEqual(repo.path, selector) ||
        repo.displayName === selector
    )
  }

  protected async resolveRepoSelector(selector: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('repo_not_found')
    }
    const candidates = this.selectReposBySelector(selector)

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('repo_not_found')
  }

  protected requireStore(): Store {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return this.store as unknown as Store
  }

  protected buildResolvedWorktreeFromId(worktreeId: string): ResolvedWorktree | null {
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed?.repoId || !parsed.worktreePath) {
      return null
    }
    const repo = this.store?.getRepos?.()?.find((entry) => entry.id === parsed.repoId)
    const git = {
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: repo ? areWorktreePathsEqual(parsed.worktreePath, repo.path) : false
    }
    const meta = this.store?.getWorktreeMeta(worktreeId)
    const merged = {
      ...mergeWorktree(parsed.repoId, git, meta, repo?.displayName),
      ...(repo ? { hostId: meta?.hostId ?? getRepoExecutionHostId(repo) } : {})
    }
    return {
      ...merged,
      id: worktreeId,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git,
      displayName: merged.displayName,
      comment: merged.comment
    }
  }
}
