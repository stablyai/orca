import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { awaitWindowsHostGitEnvironmentReady } from '../git/runner'
import { getRepoName, isGitRepo } from '../git/repo'
import { scanNestedRepos } from '../project-groups/nested-repo-discovery'
import {
  createNestedProjectGroupResolver,
  resolveNestedRepoSelection
} from '../project-groups/nested-repo-import'
import { createNestedRepoImportTargetResolver } from '../project-groups/nested-repo-import-target'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeNestedRepoImportDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

function sanitizeImportError(fallback: string, error: unknown): string {
  console.warn(`[project-groups] ${fallback}`, error)
  return 'Repository could not be imported'
}

export class RuntimeNestedRepoImport {
  constructor(private readonly deps: RuntimeNestedRepoImportDependencies) {}

  async scan(path: string): Promise<NestedRepoScanResult> {
    if (!isAbsolute(path)) {
      throw new Error('Project path must be an absolute path')
    }
    await awaitWindowsHostGitEnvironmentReady({ cwd: path })
    return scanNestedRepos({ path, options: { timeoutMs: 15_000 } })
  }

  async import(args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    mode: ProjectGroupImportMode
  }): Promise<ProjectGroupImportResult> {
    await awaitWindowsHostGitEnvironmentReady({ cwd: args.parentPath })
    const store = this.deps.getStore()
    if (!store?.createProjectGroup || !store.moveProjectToGroup) {
      throw new Error('runtime_unavailable')
    }
    if (!isAbsolute(args.parentPath)) {
      throw new Error('Project path must be an absolute path')
    }
    const scan = await scanNestedRepos({ path: args.parentPath, options: { timeoutMs: 15_000 } })
    const selection = resolveNestedRepoSelection({ scan, projectPaths: args.projectPaths })
    const groupResolver = createNestedProjectGroupResolver({
      parentPath: args.parentPath,
      groupName: args.groupName,
      mode: args.mode,
      connectionId: null,
      repoPaths: selection.selectedPaths,
      createGroup: (input) => store.createProjectGroup!(input)
    })
    const results: ProjectGroupImportResult['projects'] = selection.rejectedPaths.map(
      (repoPath) => ({
        path: repoPath,
        status: 'failed',
        error: 'Repository was not found in the nested repo scan result'
      })
    )
    const importedProjectIdsByRepoPath = new Map<string, string>()
    const importTargetResolver = createNestedRepoImportTargetResolver()
    for (const [projectGroupOrder, repoPath] of selection.selectedPaths.entries()) {
      try {
        await awaitWindowsHostGitEnvironmentReady({ cwd: repoPath })
        if (!isGitRepo(repoPath)) {
          results.push({ path: repoPath, status: 'failed', error: 'Not a valid git repository' })
          continue
        }
        const importRepoPath = await importTargetResolver.resolveLocal(repoPath)
        const normalizedImportRepoPath = normalizeRuntimePathForComparison(importRepoPath)
        const alreadyImportedProjectId = importedProjectIdsByRepoPath.get(normalizedImportRepoPath)
        if (alreadyImportedProjectId) {
          results.push({
            path: repoPath,
            projectId: alreadyImportedProjectId,
            status: 'already-known'
          })
          continue
        }
        const existing = store
          .getRepos()
          .find((repo) => normalizeRuntimePathForComparison(repo.path) === normalizedImportRepoPath)
        const group = groupResolver.getGroupForRepo(repoPath)
        if (existing) {
          if (group) {
            store.moveProjectToGroup(existing.id, group.id, projectGroupOrder)
          }
          importedProjectIdsByRepoPath.set(normalizedImportRepoPath, existing.id)
          results.push({ path: repoPath, projectId: existing.id, status: 'already-known' })
          continue
        }
        const repo: Repo = {
          id: randomUUID(),
          path: importRepoPath,
          displayName: getRepoName(importRepoPath),
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          addedAt: Date.now(),
          kind: 'git',
          externalWorktreeVisibilityLegacy: false,
          ...(group ? { projectGroupId: group.id, projectGroupOrder } : {})
        }
        store.addRepo(repo)
        importedProjectIdsByRepoPath.set(normalizedImportRepoPath, repo.id)
        results.push({ path: repoPath, projectId: repo.id, status: 'imported' })
      } catch (error) {
        results.push({
          path: repoPath,
          status: 'failed',
          error: sanitizeImportError('Failed to import nested repository in runtime', error)
        })
      }
    }
    const importedCount = results.filter((entry) => entry.status === 'imported').length
    const alreadyKnownCount = results.filter((entry) => entry.status === 'already-known').length
    const failedCount = results.filter((entry) => entry.status === 'failed').length
    if (importedCount + alreadyKnownCount === 0) {
      for (const group of groupResolver.getCreatedGroups().toReversed()) {
        store.deleteProjectGroup?.(group.id)
      }
    }
    this.deps.invalidateResolvedWorktrees()
    for (const project of results) {
      if (project.projectId) {
        this.deps.invalidateWorktreeScan(project.projectId)
      }
    }
    this.deps.notifyReposChanged()
    const rootGroup = groupResolver.getRootGroup()
    return {
      ...(rootGroup && importedCount + alreadyKnownCount > 0 ? { group: rootGroup } : {}),
      projects: results,
      importedCount,
      alreadyKnownCount,
      failedCount
    }
  }
}
