import type { Store } from '../persistence/loading-store/store'
import type { Repo } from '../../shared/repo-types'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo, isGitRepoKind } from '../../shared/repo-kind'
import { loadHooks } from '../workspace-hooks/hooks'
import type { PluginService } from '../plugins/plugin-service'
import {
  formatWorkspaceProviderTarget,
  type WorkspaceProviderTarget
} from '../../shared/workspace-provider-target'
import {
  WORKSPACE_PROVIDERS_SCHEMA_VERSION,
  type WorkspaceProviderListResult,
  type WorkspaceProviderListing
} from '../../shared/recipe-workspace-create-progress'

type PluginRecipe = { pluginKey: string; recipe: OrcaVmRecipe }

async function approvedPluginRecipes(pluginService: PluginService | null): Promise<PluginRecipe[]> {
  if (!pluginService) {
    return []
  }
  await pluginService.whenReady()
  return pluginService.contentPacks.vmRecipes
    .list()
    .map(({ pluginKey, recipe }) => ({ pluginKey, recipe }))
}

/** A refusal callers can act on: `invalid_argument` with the field and the valid choices. */
function invalidTarget(message: string, data: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code: 'invalid_argument', data })
}

function repoRecipes(repo: Repo): OrcaVmRecipe[] {
  return loadHooks(repo.path)?.environmentRecipes ?? []
}

function listedTargets(repo: Repo, plugins: readonly PluginRecipe[]): string[] {
  return [
    ...repoRecipes(repo).map((recipe) =>
      formatWorkspaceProviderTarget({ kind: 'recipe', id: recipe.id })
    ),
    ...plugins.map(({ pluginKey, recipe }) =>
      formatWorkspaceProviderTarget({ kind: 'plugin', pluginKey, id: recipe.id })
    )
  ]
}

/** The recipe a provider target names in this repo, or an `invalid_argument` listing the valid ones. */
export async function resolveWorkspaceProviderRecipe(
  repo: Repo,
  target: WorkspaceProviderTarget,
  pluginService: PluginService | null
): Promise<OrcaVmRecipe> {
  const spelled = formatWorkspaceProviderTarget(target)
  if (isFolderRepo(repo) || getRepoExecutionHostId(repo) !== 'local') {
    throw invalidTarget(`${spelled} needs a Git checkout on this computer.`, {
      field: 'on',
      target: spelled
    })
  }
  const plugins = await approvedPluginRecipes(pluginService)
  const notFound = (): Error =>
    invalidTarget(
      `No provider ${spelled} for ${repo.displayName}. Run \`orca provider list --repo id:${repo.id}\` to see the valid targets.`,
      { field: 'on', target: spelled, valid: listedTargets(repo, plugins) }
    )
  const fromRepo = repoRecipes(repo)
  if (target.kind === 'recipe') {
    const recipe = fromRepo.find((entry) => entry.id === target.id)
    if (!recipe) {
      throw notFound()
    }
    return recipe
  }
  const plugin = plugins.find(
    (entry) => entry.pluginKey === target.pluginKey && entry.recipe.id === target.id
  )
  if (!plugin) {
    throw notFound()
  }
  // Why: lifecycle steps later resolve a recipe by id with orca.yaml first; a same-id plugin
  // recipe would be suspended or destroyed with the repo's commands instead of its own.
  if (fromRepo.some((recipe) => recipe.id === target.id)) {
    throw invalidTarget(
      `${spelled} has the same id as this repo's orca.yaml recipe recipe:${target.id}, so Orca can't keep them apart. Rename one of them.`,
      { field: 'on', target: spelled }
    )
  }
  return plugin.recipe
}

function toListing(
  repo: Repo,
  target: WorkspaceProviderTarget,
  recipe: OrcaVmRecipe,
  shadowed: boolean
): WorkspaceProviderListing {
  return {
    target: formatWorkspaceProviderTarget(target),
    kind: target.kind,
    name: recipe.name,
    ...(recipe.description ? { description: recipe.description } : {}),
    repo: { id: repo.id, name: repo.displayName, path: repo.path },
    available: !shadowed,
    ...(shadowed ? { unavailableReason: 'shadowed_by_repo_recipe' } : {}),
    checkoutMode: recipe.checkoutMode ?? 'orca-worktree',
    capabilities: {
      suspend: Boolean(recipe.suspend),
      resume: Boolean(recipe.resume),
      destroy: Boolean(recipe.destroy) && recipe.destroyDisabled !== true
    },
    ...(recipe.timeoutSeconds ? { timeoutSeconds: recipe.timeoutSeconds } : {}),
    sizes: [],
    inputs: []
  }
}

/** Every provider `worktree create --on` accepts for these repos (one repo, or every local Git repo). */
export async function listWorkspaceProviders(
  store: Store,
  repo: Repo | null,
  pluginService: PluginService | null
): Promise<WorkspaceProviderListResult> {
  const plugins = await approvedPluginRecipes(pluginService)
  const repos = repo
    ? [repo]
    : store
        .getRepos()
        .filter((entry) => isGitRepoKind(entry) && !isFolderRepo(entry) && !entry.connectionId)
  const providers: WorkspaceProviderListing[] = []
  const diagnostics: WorkspaceProviderListResult['diagnostics'] = []
  for (const entry of repos) {
    if (isFolderRepo(entry) || getRepoExecutionHostId(entry) !== 'local') {
      continue
    }
    const hooks = loadHooks(entry.path)
    const fromRepo = hooks?.environmentRecipes ?? []
    for (const recipe of fromRepo) {
      providers.push(toListing(entry, { kind: 'recipe', id: recipe.id }, recipe, false))
    }
    const repoIds = new Set(fromRepo.map((recipe) => recipe.id))
    for (const { pluginKey, recipe } of plugins) {
      providers.push(
        toListing(
          entry,
          { kind: 'plugin', pluginKey, id: recipe.id },
          recipe,
          repoIds.has(recipe.id)
        )
      )
    }
    for (const diagnostic of hooks?.environmentRecipeDiagnostics ?? []) {
      diagnostics.push({ repoId: entry.id, ...diagnostic })
    }
  }
  return { schemaVersion: WORKSPACE_PROVIDERS_SCHEMA_VERSION, providers, diagnostics }
}
