/** The pairing revision a recipe VM wake left its server on. A request that waited for a wake is
 *  held to exactly that pairing, not to whatever is current after it. */
export type RecipeVmWake = { readonly pairingRevision: number }

const wakes = new Map<string, RecipeVmWake>()

/** `restartedServer`: a resume that kept its pairing still restarted the server, so it reads as a
 *  new wake; otherwise a wake that left the pairing as it was reads as no wake. */
export function noteRecipeVmWakePairing(
  environmentId: string,
  pairingRevision: number,
  restartedServer = false
): void {
  if (!restartedServer && wakes.get(environmentId)?.pairingRevision === pairingRevision) {
    return
  }
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
