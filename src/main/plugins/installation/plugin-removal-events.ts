const listeners = new Set<(pluginKey: string) => void>()

/** Hears each plugin the person uninstalls, as it is removed; returns an unsubscribe. */
export function onPluginRemoved(listener: (pluginKey: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Told only by the uninstall path: a plugin missing from a discovery is not removed. */
export function notifyPluginRemoved(pluginKey: string): void {
  for (const listener of listeners) {
    listener(pluginKey)
  }
}
