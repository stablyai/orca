const generationByEnvironment = new Map<string, number>()
const MAX_TRACKED_ENVIRONMENTS = 512
let generationSequence = 0
let evictedGeneration = 0

export function getRuntimeEnvironmentTransportGeneration(environmentId: string): number {
  return generationByEnvironment.get(environmentId) ?? evictedGeneration
}

export function advanceRuntimeEnvironmentTransportGeneration(environmentId: string): void {
  const generation = ++generationSequence
  generationByEnvironment.set(environmentId, generation)
  while (generationByEnvironment.size > MAX_TRACKED_ENVIRONMENTS) {
    const oldest = generationByEnvironment.keys().next()
    if (oldest.done) {
      break
    }
    evictedGeneration = Math.max(evictedGeneration, generationByEnvironment.get(oldest.value) ?? 0)
    generationByEnvironment.delete(oldest.value)
  }
}

export function _getRuntimeEnvironmentTransportGenerationCacheSize(): number {
  return generationByEnvironment.size
}
