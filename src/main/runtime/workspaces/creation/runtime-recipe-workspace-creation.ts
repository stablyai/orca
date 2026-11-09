import type { Repo } from '../../../../shared/repo-types'
import type {
  RecipeCatalogListing,
  RecipeWorkspaceCreatePhase
} from '../../../../shared/recipe-workspace-create-progress'
import type {
  RecipeWorkspaceCreateParams,
  RecipeWorkspaceCreation
} from '../../../ephemeral-vm/recipe-workspace-create'
import {
  buildManagedWorktreeCreateArgs,
  worktreeCreateRepoSelector
} from '../../rpc/methods/workspaces/worktree-create-args'
import { RuntimeProvisionedWorkspaceAdoption } from './runtime-provisioned-workspace-adoption'

export type RecipeWorkspaceCreateOptions = {
  /** Aborts provisioning (and destroys a started VM) when the caller goes away. */
  signal?: AbortSignal
  onPhase?: (phase: RecipeWorkspaceCreatePhase) => void
}

/** Desktop-only wiring: orcad has no recipe runner, so it never sets one and never advertises it. */
export type RecipeWorkspaceService = {
  create: (
    params: RecipeWorkspaceCreateParams,
    repo: Repo,
    options: RecipeWorkspaceCreateOptions
  ) => Promise<RecipeWorkspaceCreation>
  /** One repo's recipes, or every local repo that has any. */
  list: (repo: Repo | null) => Promise<RecipeCatalogListing[]>
}

export abstract class RuntimeRecipeWorkspaceCreation extends RuntimeProvisionedWorkspaceAdoption {
  private recipeWorkspaceService: RecipeWorkspaceService | null = null

  setRecipeWorkspaceService(service: RecipeWorkspaceService): void {
    this.recipeWorkspaceService = service
  }

  override supportsRecipeWorkspaceCreation(): boolean {
    return this.recipeWorkspaceService !== null
  }

  async listEnvironmentRecipes(repoSelector: string | undefined): Promise<RecipeCatalogListing[]> {
    if (!this.recipeWorkspaceService) {
      throw new Error('This Orca host cannot create workspaces from environment recipes.')
    }
    const repo = repoSelector ? await this.resolveRepoSelector(repoSelector) : null
    return this.recipeWorkspaceService.list(repo)
  }

  async createManagedRecipeWorkspace(
    params: RecipeWorkspaceCreateParams,
    options: RecipeWorkspaceCreateOptions = {}
  ): Promise<RecipeWorkspaceCreation> {
    if (!this.recipeWorkspaceService) {
      throw new Error('This Orca host cannot create workspaces from environment recipes.')
    }
    const repo = await this.resolveRepoSelector(worktreeCreateRepoSelector(params))
    const args = buildManagedWorktreeCreateArgs(params, {})
    // Same lineage input as an ordinary create, so a note-task comment infers its parent here.
    const lineage = await this.resolveLineageForWorktreeCreate(
      args.lineage || args.comment ? { ...args.lineage, comment: args.comment } : undefined,
      repo
    )
    const result = await this.recipeWorkspaceService.create(params, repo, options)
    const recorded = this.recordCreatedWorktreeLineage(result.worktree, lineage)
    this.notifyReposChanged()
    this.notifyWorktreesChanged(result.worktree.repoId)
    // No lifecycle event: plugin events carry `path` as a path on this machine, and this one is inside the VM.
    // No activation either: this host's window cannot resolve a workspace that lives on another host.
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
