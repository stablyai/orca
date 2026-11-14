import type { Store } from '../persistence/loading-store/store'
import { loadHooks } from '../workspace-hooks/hooks'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { isFolderRepo, isGitRepoKind } from '../../shared/repo-kind'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import {
  EphemeralVmFailureError,
  ephemeralVmFailure,
  type EphemeralVmFailure
} from '../../shared/ephemeral-vm-failure-copy'

export type EphemeralVmRecipeListResult = {
  status: 'ok' | 'error'
  repoPath: string | null
  recipes: OrcaVmRecipe[]
  diagnostics: NonNullable<ReturnType<typeof loadHooks>>['environmentRecipeDiagnostics']
  message?: string
  messageCode?: string
  messageParams?: Record<string, string | number>
}

export type EphemeralVmRecipeCatalogEntry = {
  repoId: string
  repoName: string
  repoPath: string
  recipes: OrcaVmRecipe[]
  diagnostics: NonNullable<ReturnType<typeof loadHooks>>['environmentRecipeDiagnostics']
}

export type RecipeRepoResult =
  | { ok: true; repo: Exclude<ReturnType<Store['getRepo']>, null | undefined> }
  | {
      ok: false
      message: string
      failure: EphemeralVmFailure
      doctor: (recipeId: string) => EphemeralVmRecipeDoctorResult
    }

export function listRecipes(
  store: Store,
  repoId: string,
  pluginRecipes: readonly OrcaVmRecipe[] = []
): EphemeralVmRecipeListResult {
  const repo = store.getRepo(repoId)
  if (!repo || isFolderRepo(repo)) {
    return failedRecipeList(null, ephemeralVmFailure('repoNotFound', { repoId }))
  }
  if (repo.connectionId) {
    return failedRecipeList(repo.path, ephemeralVmFailure('remoteRepoUnsupported'))
  }
  const hooks = loadHooks(repo.path)
  return {
    status: 'ok',
    repoPath: repo.path,
    recipes: combineEphemeralVmRecipes(hooks?.environmentRecipes ?? [], pluginRecipes),
    diagnostics: hooks?.environmentRecipeDiagnostics ?? []
  }
}

export function listRecipeCatalog(
  store: Store,
  pluginRecipes: readonly OrcaVmRecipe[] = []
): EphemeralVmRecipeCatalogEntry[] {
  return store
    .getRepos()
    .filter((repo) => isGitRepoKind(repo) && !isFolderRepo(repo) && !repo.connectionId)
    .map((repo) => {
      const hooks = loadHooks(repo.path)
      return {
        repoId: repo.id,
        repoName: repo.displayName,
        repoPath: repo.path,
        recipes: combineEphemeralVmRecipes(hooks?.environmentRecipes ?? [], pluginRecipes),
        diagnostics: hooks?.environmentRecipeDiagnostics ?? []
      }
    })
    .filter((entry) => entry.recipes.length > 0 || entry.diagnostics.length > 0)
}

export function getRecipeRepo(store: Store, repoId: string): RecipeRepoResult {
  const repo = store.getRepo(repoId)
  if (!repo || isFolderRepo(repo)) {
    return failedRecipeRepo(null, ephemeralVmFailure('repoNotFound', { repoId }))
  }
  if (repo.connectionId) {
    return failedRecipeRepo(repo.path, ephemeralVmFailure('remoteRepoUnsupported'))
  }
  return { ok: true, repo }
}

export function getRuntimeRecipeContext(
  store: Store,
  userDataPath: string,
  runtimeId: string
): {
  runtime: EphemeralVmRuntimeRecord
  repoPath: string
  recipe: OrcaVmRecipe
} {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new EphemeralVmFailureError(ephemeralVmFailure('runtimeNotFound', { runtimeId }))
  }
  const repo = runtime.repoId ? getRecipeRepo(store, runtime.repoId) : null
  if (!repo?.ok) {
    // Why: a re-added or removed repo must not strand the VM; the snapshot plus recorded checkout
    // path are everything destroy needs (stablyai/orca#17293). Only trust the path while it still
    // holds the same recipe, so a different checkout later placed there can't run its scripts.
    const fallback = runtime.recipe && runtime.repoPath ? runtime.recipe : null
    if (fallback && runtime.repoPath) {
      const sameRecipe = (loadHooks(runtime.repoPath)?.environmentRecipes ?? []).find(
        (entry) => entry.id === fallback.id && entry.create === fallback.create
      )
      if (sameRecipe) {
        const passEnv = sameRecipe.passEnv ? { passEnv: sameRecipe.passEnv } : {}
        return { runtime, repoPath: runtime.repoPath, recipe: { ...fallback, ...passEnv } }
      }
    }
    throw new EphemeralVmFailureError(
      repo ? repo.failure : ephemeralVmFailure('runtimeRepoMissing', { runtimeId })
    )
  }
  const repoRecipe = (loadHooks(repo.repo.path)?.environmentRecipes ?? []).find(
    (entry) => entry.id === runtime.recipeId
  )
  // Legacy runtimes lack snapshots; never substitute a newer same-ID plugin recipe for their repo-owned recipe.
  // Snapshots never persist timeoutSeconds, so take the repo's current limits (lifecycle commands stay
  // snapshotted). Only when the repo recipe has the same create command, so a different recipe that
  // later took this id (e.g. a repo recipe shadowing a plugin one) cannot impose its limits.
  // passEnv follows the same rule, so suspend/resume/destroy see the environment create saw.
  const sameCreate = repoRecipe !== undefined && repoRecipe.create === runtime.recipe?.create
  const fromRepo = {
    ...(sameCreate && repoRecipe.timeoutSeconds
      ? { timeoutSeconds: repoRecipe.timeoutSeconds }
      : {}),
    ...(sameCreate && repoRecipe.passEnv ? { passEnv: repoRecipe.passEnv } : {})
  }
  const recipe = runtime.recipe ? { ...runtime.recipe, ...fromRepo } : repoRecipe
  if (!recipe) {
    throw new EphemeralVmFailureError(
      ephemeralVmFailure('recipeNotFound', { recipeId: runtime.recipeId })
    )
  }
  return { runtime, repoPath: repo.repo.path, recipe }
}

export function resolveRecipeForRepo(
  repoPath: string,
  recipeId: string,
  pluginRecipes: readonly OrcaVmRecipe[] = []
): OrcaVmRecipe | null {
  return (
    combineEphemeralVmRecipes(loadHooks(repoPath)?.environmentRecipes ?? [], pluginRecipes).find(
      (recipe) => recipe.id === recipeId
    ) ?? null
  )
}

/** Project-owned recipes are authoritative for their repository and shadow
 * same-id global plugin recipes without disabling the rest of the pack. */
export function combineEphemeralVmRecipes(
  repoRecipes: readonly OrcaVmRecipe[],
  pluginRecipes: readonly OrcaVmRecipe[]
): OrcaVmRecipe[] {
  const repoIds = new Set(repoRecipes.map((recipe) => recipe.id))
  return [...repoRecipes, ...pluginRecipes.filter((recipe) => !repoIds.has(recipe.id))]
}

function failedRecipeRepo(repoPath: string | null, failure: EphemeralVmFailure): RecipeRepoResult {
  const message = failure.error
  return {
    ok: false,
    message,
    failure,
    doctor: (recipeId) => ({
      recipeId,
      repoPath: repoPath ?? '',
      ok: false,
      checks: [
        {
          id: 'recipe.execution_target',
          status: 'fail',
          message,
          remediation: 'Use a local repo checkout for the recipe.'
        }
      ]
    })
  }
}

function failedRecipeList(
  repoPath: string | null,
  failure: EphemeralVmFailure
): EphemeralVmRecipeListResult {
  return {
    status: 'error',
    repoPath,
    recipes: [],
    diagnostics: [],
    message: failure.error,
    ...(failure.errorCode ? { messageCode: failure.errorCode } : {}),
    ...(failure.errorParams ? { messageParams: failure.errorParams } : {})
  }
}
