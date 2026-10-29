import type { SessionPaneAliasRecipe } from '../../persistence/restoring-sessions/session-pane-alias-recipes'
export class PaneAliasRecipeSources {
  private readonly recipesBySource = new Map<string, readonly SessionPaneAliasRecipe[]>()
  private readonly sourcesByAlias = new Map<string, Map<string, SessionPaneAliasRecipe>>()
  replace(source: string, recipes: readonly SessionPaneAliasRecipe[]): void {
    const retained = new Set(recipes.map((recipe) => recipe.legacyPaneKey))
    for (const recipe of this.recipesBySource.get(source) ?? []) {
      if (retained.has(recipe.legacyPaneKey)) {
        continue
      }
      const sources = this.sourcesByAlias.get(recipe.legacyPaneKey)
      sources?.delete(source)
      if (!sources?.size) {
        this.sourcesByAlias.delete(recipe.legacyPaneKey)
      }
    }
    if (recipes.length) {
      this.recipesBySource.set(source, recipes)
    } else {
      this.recipesBySource.delete(source)
    }
    for (const recipe of recipes) {
      const sources = this.sourcesByAlias.get(recipe.legacyPaneKey) ?? new Map()
      sources.set(source, recipe)
      this.sourcesByAlias.set(recipe.legacyPaneKey, sources)
    }
  }
  first(key: string): SessionPaneAliasRecipe | undefined {
    return this.sourcesByAlias.get(key)?.values().next().value
  }
}
