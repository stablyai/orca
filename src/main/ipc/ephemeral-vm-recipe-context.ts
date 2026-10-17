import { isAbsolute } from 'node:path'
import type { Store } from '../persistence'
import { loadHooks } from '../hooks'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { isFolderRepo, isGitRepoKind } from '../../shared/repo-kind'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'

export type EphemeralVmRecipeListResult = {
  status: 'ok' | 'error'
  repoPath: string | null
  recipes: OrcaVmRecipe[]
  diagnostics: NonNullable<ReturnType<typeof loadHooks>>['environmentRecipeDiagnostics']
  message?: string
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
  | { ok: false; message: string; doctor: (recipeId: string) => EphemeralVmRecipeDoctorResult }

export function listRecipes(
  store: Store,
  repoId: string,
  pluginRecipes: readonly OrcaVmRecipe[] = []
): EphemeralVmRecipeListResult {
  const repo = store.getRepo(repoId)
  if (!repo || isFolderRepo(repo)) {
    return {
      status: 'error',
      repoPath: null,
      recipes: [],
      diagnostics: [],
      message: `Repo not found: ${repoId}`
    }
  }
  if (repo.connectionId) {
    return {
      status: 'error',
      repoPath: repo.path,
      recipes: [],
      diagnostics: [],
      message: 'Ephemeral VM recipes run on the local desktop host in v1.'
    }
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
    return failedRecipeRepo(null, `Repo not found: ${repoId}`)
  }
  if (repo.connectionId) {
    return failedRecipeRepo(repo.path, 'Ephemeral VM recipes run on the local desktop host in v1.')
  }
  return { ok: true, repo }
}

export function getRuntimeRecipeContext(
  store: Store,
  userDataPath: string,
  runtimeId: string
): {
  runtime: EphemeralVmRuntimeRecord
  repo: Extract<RecipeRepoResult, { ok: true }>
  recipe: OrcaVmRecipe
} {
  return resolveRuntimeRecipeContext(store, readRuntimeRecipeRecord(userDataPath, runtimeId))
}

export function getRuntimeRecipeCleanupContext(
  store: Store,
  userDataPath: string,
  runtimeId: string
): { runtime: EphemeralVmRuntimeRecord; recipe: OrcaVmRecipe; repoPath: string } {
  const runtime = readRuntimeRecipeRecord(userDataPath, runtimeId)
  if (runtime.repoId && !store.getRepo(runtime.repoId) && runtime.recipe && runtime.recipeSource) {
    const repoPath = runtime.recipeSource.repoPath
    if (!isAbsolute(repoPath)) {
      throw new Error(`Recipe repo path is not absolute: ${repoPath}`)
    }
    return { runtime, recipe: runtime.recipe, repoPath }
  }
  const context = resolveRuntimeRecipeContext(store, runtime)
  return { runtime, recipe: context.recipe, repoPath: context.repo.repo.path }
}

function readRuntimeRecipeRecord(
  userDataPath: string,
  runtimeId: string
): EphemeralVmRuntimeRecord {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
  }
  return runtime
}

function resolveRuntimeRecipeContext(store: Store, runtime: EphemeralVmRuntimeRecord) {
  if (!runtime.repoId) {
    throw new Error(`Ephemeral VM runtime has no repo id: ${runtime.id}`)
  }
  const repo = getRecipeRepo(store, runtime.repoId)
  if (!repo.ok) {
    throw new Error(repo.message)
  }
  // Pre-snapshot runtimes can only be attributed to repo-owned recipes. Never
  // substitute a later same-id plugin recipe for an older runtime lifecycle.
  const recipe =
    runtime.recipe ??
    (loadHooks(repo.repo.path)?.environmentRecipes ?? []).find(
      (entry) => entry.id === runtime.recipeId
    )
  if (!recipe) {
    throw new Error(`Recipe not found: ${runtime.recipeId}`)
  }
  return { runtime, repo, recipe }
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

function failedRecipeRepo(repoPath: string | null, message: string): RecipeRepoResult {
  return {
    ok: false,
    message,
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
