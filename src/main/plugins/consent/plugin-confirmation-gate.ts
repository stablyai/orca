import { PluginHostCallError } from '../workers/host-api/plugin-host-call-scope'
import type { PluginActionConfirmation } from './plugin-confirmation-subject'

/** How long a plugin waits to ask again after the person said no. */
export const PLUGIN_CONFIRMATION_COOLDOWN_MS = 30_000

/**
 * One question per plugin at a time, and a pause after a refusal, so a plugin cannot stack
 * dialogs or re-ask until the person gives in. Refused calls get `rate_limited`.
 */
export function createPluginConfirmationGate(now: () => number = Date.now) {
  const asking = new Set<string>()
  const quietUntil = new Map<string, number>()
  return async function ask(
    pluginId: string,
    question: () => Promise<PluginActionConfirmation>
  ): Promise<PluginActionConfirmation> {
    if (asking.has(pluginId)) {
      throw new PluginHostCallError('rate_limited', 'Orca is already asking about this plugin')
    }
    const wait = (quietUntil.get(pluginId) ?? 0) - now()
    if (wait > 0) {
      throw new PluginHostCallError(
        'rate_limited',
        'the person just declined; try again later',
        wait
      )
    }
    asking.add(pluginId)
    try {
      const answer = await question()
      if (answer === 'cancelled') {
        quietUntil.set(pluginId, now() + PLUGIN_CONFIRMATION_COOLDOWN_MS)
      }
      return answer
    } finally {
      asking.delete(pluginId)
    }
  }
}
