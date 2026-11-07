/** The pairing revision each recipe VM wake left its server on, by environment. A request that
 *  waited for a wake is held to exactly that pairing, not to whatever is current after it. */
const wakePairings = new Map<string, number>()

export function noteRecipeVmWakePairing(environmentId: string, pairingRevision: number): void {
  wakePairings.set(environmentId, pairingRevision)
}

export function recipeVmWakePairing(environmentId: string): number | undefined {
  return wakePairings.get(environmentId)
}

export function forgetRecipeVmWakePairingsForTests(): void {
  wakePairings.clear()
}
