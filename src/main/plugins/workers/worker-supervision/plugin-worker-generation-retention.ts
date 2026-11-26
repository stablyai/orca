export function forgetPluginWorkerGenerationIfIdle(
  pluginKey: string,
  activations: ReadonlyMap<string, unknown>,
  workers: ReadonlyMap<string, unknown>,
  knownSpecs: ReadonlyMap<string, unknown>,
  generations: Map<string, number>
): void {
  if (activations.has(pluginKey) || workers.has(pluginKey) || knownSpecs.has(pluginKey)) {
    return
  }
  generations.delete(pluginKey)
}

export function nextPluginWorkerGeneration(
  pluginKey: string,
  generations: Map<string, number>
): number {
  const generation = (generations.get(pluginKey) ?? 0) + 1
  generations.set(pluginKey, generation)
  return generation
}
