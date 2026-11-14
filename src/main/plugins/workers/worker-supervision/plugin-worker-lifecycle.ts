export function pluginWorkerErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function finishPluginWorkerActivation<T>(
  activations: Map<string, T>,
  pluginKey: string,
  record: T
): void {
  if (activations.get(pluginKey) === record) {
    activations.delete(pluginKey)
  }
}
