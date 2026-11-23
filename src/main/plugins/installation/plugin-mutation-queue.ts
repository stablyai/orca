/** Serializes plugin writes per install directory or catalog snapshot. */
const pluginMutationChains = new Map<string, Promise<void>>()

export async function serializePluginMutation<T>(
  resourcePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = pluginMutationChains.get(resourcePath) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(operation)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  pluginMutationChains.set(resourcePath, settled)
  try {
    return await run
  } finally {
    if (pluginMutationChains.get(resourcePath) === settled) {
      pluginMutationChains.delete(resourcePath)
    }
  }
}
