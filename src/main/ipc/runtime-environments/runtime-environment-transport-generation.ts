const generationByEnvironment = new Map<string, number>()
const MAX_TRACKED_ENVIRONMENTS = 512
let generationSequence = 0
let evictedGeneration = 0
const advanceListeners = new Set<() => void>()

/** Owners of generation-fenced streams end the ones an advance (or eviction) left behind. */
export function onRuntimeEnvironmentTransportGenerationAdvanced(listener: () => void): void {
  advanceListeners.add(listener)
}

export function getRuntimeEnvironmentTransportGeneration(environmentId: string): number {
  return generationByEnvironment.get(environmentId) ?? evictedGeneration
}

/** True while the environment's transport is the one that was current when this was called. */
export function captureRuntimeEnvironmentTransportGeneration(environmentId: string): () => boolean {
  const generation = getRuntimeEnvironmentTransportGeneration(environmentId)
  return () => getRuntimeEnvironmentTransportGeneration(environmentId) === generation
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
  // A fenced stream drops every later frame, so it must end rather than wait silently.
  for (const listener of advanceListeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[runtime-environments] retiring stale-generation streams failed:', error)
    }
  }
}

export function _getRuntimeEnvironmentTransportGenerationCacheSize(): number {
  return generationByEnvironment.size
}
