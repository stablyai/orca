import { z } from 'zod'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import type {
  PluginHostCallOutcome,
  PluginSurface
} from '../../../shared/plugins/frames/plugin-protocol'
import { executePluginHostCall, type ExecutePluginHostCallInput } from './plugin-host-methods'

const pluginHostCallRequestSchema = z
  .object({
    method: z.string().min(1).max(128),
    params: z.unknown().optional()
  })
  .strict()

export type PluginHostCallPolicy = Pick<
  ExecutePluginHostCallInput,
  'grantedCapabilities' | 'services' | 'audit'
>

export type ResolvePluginHostCallPolicy = (
  pluginKey: string
) => PluginHostCallPolicy | Promise<PluginHostCallPolicy>

/** Authenticate transport input and resolve host policy before capability/schema/audit checks. */
export async function executePluginHostCallRequest(input: {
  /** Qualified identity already authenticated by the owning transport. */
  pluginKey: string
  request: unknown
  surface: PluginSurface
  resolvePolicy: ResolvePluginHostCallPolicy
}): Promise<PluginHostCallOutcome> {
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
    surface: input.surface,
    ...policy
  })
}
