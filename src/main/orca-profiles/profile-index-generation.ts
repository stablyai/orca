// Bumped on every profile index write (sign-in, sign-out, team switch, profile switch). Caches
// derived from the signed-in identity compare generations instead of re-reading the index per call.
let generation = 0

export function bumpOrcaProfileIndexGeneration(): void {
  generation += 1
}

export function getOrcaProfileIndexGeneration(): number {
  return generation
}
