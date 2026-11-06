/** The pairing revision a recipe VM wake left its server on. A request that waited for a wake is
 *  held to exactly that pairing, not to whatever is current after it. */
export type RecipeVmWake = { readonly pairingRevision: number }

/** One object per wake: a resume that kept the pairing still reads as a new wake. */
const wakes = new Map<string, RecipeVmWake>()

export function noteRecipeVmWakePairing(environmentId: string, pairingRevision: number): void {
  wakes.set(environmentId, { pairingRevision })
}

export function latestRecipeVmWake(environmentId: string): RecipeVmWake | undefined {
  return wakes.get(environmentId)
}

export function recipeVmWakePairing(environmentId: string): number | undefined {
  return wakes.get(environmentId)?.pairingRevision
}

export function forgetRecipeVmWakePairingsForTests(): void {
  wakes.clear()
}
