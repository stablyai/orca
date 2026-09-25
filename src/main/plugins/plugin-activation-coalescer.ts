/**
 * One in-flight activation per plugin key.
 *
 * A surface that opens a contributed task source fires several calls at once,
 * and an idle plugin has no proxy registered for any of them. Without this,
 * each call starts its own activation and re-resolves against whatever the
 * registry holds when its own attempt settles — a caller whose attempt loses
 * the race sees nothing registered and reports the source unavailable while a
 * sibling call succeeds. Joining one attempt means every caller re-resolves
 * only after the same settled activation.
 */

export type PluginActivationCoalescer = {
  /** Resolves or rejects with the shared attempt, identically for every
   *  caller that joined it. A later call starts a fresh attempt. */
  activate(pluginKey: string): Promise<void>
}

export function createPluginActivationCoalescer(
  start: (pluginKey: string) => Promise<void>
): PluginActivationCoalescer {
  const inFlight = new Map<string, Promise<void>>()

  return {
    activate(pluginKey) {
      const joined = inFlight.get(pluginKey)
      if (joined) {
        return joined
      }
      // Dropped once settled: a later call must get a fresh attempt, and a
      // failed one must not be cached as the key's permanent answer.
      const attempt = start(pluginKey).finally(() => inFlight.delete(pluginKey))
      inFlight.set(pluginKey, attempt)
      return attempt
    }
  }
}
