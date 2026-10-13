import type { Repo } from '../../../../shared/repo-types'
import type {
  RecipeWorkspaceCreateParams,
  RecipeWorkspaceCreation
} from '../../../ephemeral-vm/recipe-workspace-create'
import {
  buildManagedWorktreeCreateArgs,
  worktreeCreateRepoSelector
} from '../../rpc/methods/workspaces/worktree-create-args'
import { RuntimeProvisionedWorkspaceAdoption } from './runtime-provisioned-workspace-adoption'

type RecipeWorkspaceCreator = (
  params: RecipeWorkspaceCreateParams,
  repo: Repo
) => Promise<RecipeWorkspaceCreation>

export abstract class RuntimeRecipeWorkspaceCreation extends RuntimeProvisionedWorkspaceAdoption {
  private recipeWorkspaceCreator: RecipeWorkspaceCreator | null = null

  setRecipeWorkspaceCreator(creator: RecipeWorkspaceCreator): void {
    this.recipeWorkspaceCreator = creator
  }

  supportsRecipeWorkspaceCreation(): boolean {
    return this.recipeWorkspaceCreator !== null
  }

  async createManagedRecipeWorkspace(
    params: RecipeWorkspaceCreateParams
  ): Promise<RecipeWorkspaceCreation> {
    if (!this.recipeWorkspaceCreator) {
      throw new Error('Environment recipes are not supported by this Orca host.')
    }
    const repo = await this.resolveRepoSelector(worktreeCreateRepoSelector(params))
    const args = buildManagedWorktreeCreateArgs(params, {})
    const lineage = await this.resolveLineageForWorktreeCreate(args.lineage, repo)
    const result = await this.recipeWorkspaceCreator(params, repo)
    const recorded = this.recordCreatedWorktreeLineage(result.worktree, lineage)
    this.notifyReposChanged()
    this.notifyWorktreesChanged(result.worktree.repoId)
    this.emitWorktreeLifecycle({
      kind: 'created',
      worktreeId: result.worktree.id,
      path: result.worktree.path
    })
    if (params.activate === true) {
      this.notifyActivateWorktree(result.worktree.repoId, result.worktree.id)
    }
    return {
      ...result,
      ...recorded,
      worktree: {
        ...result.worktree,
        parentWorktreeId: recorded.lineage?.parentWorktreeId ?? null,
        lineage: recorded.lineage,
        workspaceLineage: recorded.workspaceLineage
      }
    }
  }
}
