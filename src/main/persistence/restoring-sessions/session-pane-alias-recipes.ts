import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

export type SessionPaneAliasRecipe = Omit<LegacyPaneKeyAliasEntry, 'ptyId'> & { ptyId?: string }
const recipes = new WeakMap<TerminalLayoutSnapshot, readonly SessionPaneAliasRecipe[]>()

export function rememberSessionPaneAliasRecipes(
  layout: TerminalLayoutSnapshot,
  entries: readonly SessionPaneAliasRecipe[]
): void {
  const merged = new Map((recipes.get(layout) ?? []).map((entry) => [entry.legacyPaneKey, entry]))
  for (const entry of entries) {
    merged.set(entry.legacyPaneKey, entry)
  }
  recipes.set(layout, [...merged.values()])
}

export function sessionPaneAliasRecipes(
  layout: TerminalLayoutSnapshot
): readonly SessionPaneAliasRecipe[] {
  return recipes.get(layout) ?? []
}
