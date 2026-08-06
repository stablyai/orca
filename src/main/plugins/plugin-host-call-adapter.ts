import { z } from 'zod'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { executePluginHostCall, type ExecutePluginHostCallInput } from './plugin-host-methods'

const pluginHostCallRequestSchema = z
  .object({
    method: z.string().min(1).max(128),
    params: z.unknown().optional()
  })
  .strict()

export type PluginHostCallRequest = z.infer<typeof pluginHostCallRequestSchema>

export function isPluginHostCallRequest(request: unknown): request is PluginHostCallRequest {
  return pluginHostCallRequestSchema.safeParse(request).success
}

export type PluginHostCallPolicy = Pick<
  ExecutePluginHostCallInput,
  'grantedCapabilities' | 'services' | 'audit'
>

export type ResolvePluginHostCallPolicy = (
  pluginKey: string
) => PluginHostCallPolicy | Promise<PluginHostCallPolicy>

/** Validates the transport envelope, resolves all authority host-side, then
 *  enters the one capability/schema/audit execution chokepoint. */
export async function executePluginHostCallRequest(input: {
  /** Qualified identity already authenticated by the owning transport. */
  pluginKey: string
  request: unknown
  viaPanel: boolean
  resolvePolicy: ResolvePluginHostCallPolicy
}): Promise<PluginPanelActionOutcome> {
  if (!isQualifiedPluginKey(input.pluginKey)) {
    return { ok: false, code: 'invalid_request', error: 'invalid qualified plugin key' }
  }
  const parsed = pluginHostCallRequestSchema.safeParse(input.request)
  if (!parsed.success) {
    return { ok: false, code: 'invalid_request', error: 'malformed plugin host call request' }
  }
  let policy: PluginHostCallPolicy
  try {
    policy = await input.resolvePolicy(input.pluginKey)
  } catch {
    return { ok: false, code: 'unavailable', error: 'plugin host policy is not available' }
  }
  return executePluginHostCall({
    pluginId: input.pluginKey,
    method: parsed.data.method,
    params: parsed.data.params,
    viaPanel: input.viaPanel,
    ...policy
  })
}
