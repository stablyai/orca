// The runtime's `references list` / `references find`: which workspaces to read, from the warm worktree cache.
import { getRepoExecutionHostId } from '../../shared/execution-host/execution-host'
import type { Repo } from '../../shared/repository/repo-types'
import type { RuntimeReferenceFindParams } from '../../shared/workspace-attachments/runtime-reference-contracts'
import type { Worktree } from '../../shared/worktree/types'
import {
  listReferenceWorkspaces,
  listWorkspaceReferences,
  selectWarmedReferenceWorkspace
} from './workspaces/references/runtime-reference-catalog'
import {
  findWorkspaceReferences,
  type ReferenceAgentIndex
} from './workspaces/references/runtime-reference-find'

export type WorkspaceReferenceSources = {
  store: () => Parameters<typeof listReferenceWorkspaces>[0]
  cachedWorktrees: () => readonly Worktree[] | undefined
  scanWorktrees: () => Promise<readonly Worktree[]>
  resolveRepo: (selector: string) => Promise<Repo>
  agents: (workspaceKeys: ReadonlySet<string>) => Promise<ReferenceAgentIndex>
}

export class WorkspaceReferenceQueries {
  constructor(private readonly sources: WorkspaceReferenceSources) {}

  private select(selector: string, cwd?: string) {
    return selectWarmedReferenceWorkspace(
      this.sources.store(),
      { cached: this.sources.cachedWorktrees, scan: this.sources.scanWorktrees },
      selector,
      cwd
    )
  }

  async list(selector: string, cwd?: string) {
    return listWorkspaceReferences(await this.select(selector, cwd))
  }

  async find(params: RuntimeReferenceFindParams) {
    if (params.worktree && params.repo) {
      throw new Error('--repo and --worktree cannot be combined')
    }
    let workspaces = params.worktree
      ? [await this.select(params.worktree, params.cwd)]
      : listReferenceWorkspaces(this.sources.store(), this.sources.cachedWorktrees())
    if (params.repo) {
      const repo = await this.sources.resolveRepo(params.repo)
      workspaces = workspaces.filter(
        (row) =>
          row.kind === 'worktree' &&
          row.repoId === repo.id &&
          row.hostId === getRepoExecutionHostId(repo)
      )
    }
    return findWorkspaceReferences(params, { workspaces, agents: this.sources.agents })
  }
}
