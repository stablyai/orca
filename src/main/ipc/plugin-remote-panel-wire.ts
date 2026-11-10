import { z } from 'zod'
import { panelSessionTokenSchema } from '../../shared/plugins/frames/plugin-frame-bridge'
import {
  PLUGIN_ERROR_CODES,
  type PluginHostCallOutcome
} from '../../shared/plugins/frames/plugin-protocol'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

/** One `plugins.panelSession` stream event from the paired host. */
export const hostPanelEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), sessionToken: panelSessionTokenSchema }),
  z.object({ type: z.literal('push'), push: z.unknown() }),
  z.object({ type: z.literal('end') })
])

const panelActionAnswerSchema = z.object({
  outcome: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({
      ok: z.literal(false),
      code: z.enum(PLUGIN_ERROR_CODES).catch('action_failed'),
      error: z.string().max(8192),
      retryAfterMs: z.number().int().nonnegative().optional()
    })
  ])
})

/** The host's `plugins.panelAction` answer as the frame expects it; anything else is a failure. */
export function hostPanelCallOutcome(
  response: RuntimeRpcResponse<unknown>,
  hostName: string
): PluginHostCallOutcome {
  if (!response.ok) {
    return { ok: false, code: 'unavailable', error: `${hostName}: ${response.error.message}` }
  }
  const answer = panelActionAnswerSchema.safeParse(response.result)
  if (!answer.success) {
    return { ok: false, code: 'action_failed', error: `${hostName} sent an unknown answer` }
  }
  const { outcome } = answer.data
  return outcome.ok ? { ok: true, value: outcome.value } : outcome
}
