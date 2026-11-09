import type { CommandHandler } from '../dispatch'
import type { RecipeCatalogListing } from '../../shared/recipe-workspace-create-progress'
import { assertRecipeHost } from './worktree-create-recipe'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'

export function formatRecipeListing(result: { repos: RecipeCatalogListing[] }): string {
  if (result.repos.length === 0) {
    return 'No environment recipes. Add environmentRecipes to a repo orca.yaml.'
  }
  const lines: string[] = []
  for (const repo of result.repos) {
    lines.push(`${repo.repoName} (${repo.repoPath})`)
    if (repo.recipes.length === 0) {
      lines.push('  no recipes')
    }
    for (const recipe of repo.recipes) {
      const destroy = recipe.destroyDisabled
        ? 'destroy disabled'
        : recipe.steps.includes('destroy')
          ? 'destroys on removal'
          : 'no destroy step'
      const timeouts = recipe.timeoutSeconds
        ? Object.entries(recipe.timeoutSeconds)
            .map(([step, seconds]) => `${step} ${seconds}s`)
            .join(', ')
        : ''
      lines.push(
        `  ${recipe.id}  ${recipe.name}  [${recipe.checkoutMode}; ${destroy}${timeouts ? `; timeouts ${timeouts}` : ''}]`
      )
      if (recipe.description) {
        lines.push(`      ${recipe.description}`)
      }
    }
    for (const diagnostic of repo.diagnostics) {
      lines.push(
        `  warning: environmentRecipes[${diagnostic.index}]${diagnostic.field ? `.${diagnostic.field}` : ''}: ${diagnostic.message}`
      )
    }
  }
  return lines.join('\n')
}

export const VM_RECIPE_LIST_HANDLERS: Record<string, CommandHandler> = {
  'vm recipe list': async ({ flags, client, json }) => {
    await assertRecipeHost(client)
    const repo = getOptionalStringFlag(flags, 'repo')
    const result = await client.call<{ repos: RecipeCatalogListing[] }>(
      'vmRecipe.list',
      repo ? { repo } : {}
    )
    printResult(result, json, formatRecipeListing)
  }
}
