import type { Repo } from '../../../../shared/repo-types'
import type {
  RecipeCatalogListing,
  RecipeWorkspaceCreatePhase
} from '../../../../shared/recipe-workspace-create-progress'
import type {
  RecipeWorkspaceCreateParams,
  RecipeWorkspaceCreation
} from '../../../ephemeral-vm/recipe-workspace-create-params'
import type {
  RecipeWorkspaceRemoval as RecipeWorkspaceRemovalResult,
  RecipeWorkspaceRemoveParams
} from '../../../ephemeral-vm/workspace-removal'
import { worktreeCreateRepoSelector } from '../../rpc/methods/workspaces/worktree-create-args'
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

/** Desktop-only wiring: removal of a workspace whose recipe environment this host provisioned. */
export type RecipeWorkspaceRemoval = {
  owns: (params: RecipeWorkspaceRemoveParams) => boolean
  remove: (params: RecipeWorkspaceRemoveParams) => Promise<RecipeWorkspaceRemovalResult>
}

export abstract class RuntimeRecipeWorkspaceCreation extends RuntimeProvisionedWorkspaceAdoption {
  private recipeWorkspaceService: RecipeWorkspaceService | null = null
  private recipeWorkspaceRemoval: RecipeWorkspaceRemoval | null = null

  setRecipeWorkspaceRemoval(removal: RecipeWorkspaceRemoval): void {
    this.recipeWorkspaceRemoval = removal
  }

  /** Throws when several recipe records claim the workspace, so nothing is destroyed on a guess. */
  ownsRecipeWorkspaceRemoval(params: RecipeWorkspaceRemoveParams): boolean {
    return this.recipeWorkspaceRemoval?.owns(params) ?? false
  }

  removeRecipeWorkspace(
    params: RecipeWorkspaceRemoveParams
  ): Promise<RecipeWorkspaceRemovalResult> {
    if (!this.recipeWorkspaceRemoval) {
      throw new Error('This Orca host cannot remove recipe workspaces.')
    }
    return this.recipeWorkspaceRemoval.remove(params)
  }

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
    const result = await this.recipeWorkspaceService.create(params, repo, options)
    this.notifyReposChanged()
    this.notifyWorktreesChanged(result.worktree.repoId)
    // No lifecycle event: plugin events carry `path` as a path on this machine, and this one is inside the VM.
    // No activation either: this host's window cannot resolve a workspace that lives on another host.
    // No lineage: this host's store would record a parent edge to a workspace it does not hold,
    // which the sidebar reads as a missing parent.
    return {
      ...result,
      lineage: null,
      workspaceLineage: null,
      warnings: [],
      worktree: {
        ...result.worktree,
        parentWorktreeId: null,
        lineage: null,
        workspaceLineage: null
      }
    }
  }
}
