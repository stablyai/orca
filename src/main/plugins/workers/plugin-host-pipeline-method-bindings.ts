import * as z from 'zod'
import { PLUGIN_HOST_API } from '../../../shared/plugins/workers/plugin-host-api'
import { bind, type PluginHostMethodContext } from './host-api/plugin-host-method-bind'
import { PluginHostCallError } from './host-api/plugin-host-call-scope'
import { pluginHostEffect as invokePluginWorkspaceEffect } from './host-api/plugin-host-runtime-call'

const runSchema = z.object({
  id: z.string(),
  workspace: z.object({ id: z.string() }),
  provider: z.object({ pluginKey: z.string() }),
  profile: z.object({ title: z.string() }),
  stage: z.string(),
  state: z.string(),
  revision: z.number(),
  fixCycles: z.number(),
  reason: z.string().optional()
})
async function read(ctx: PluginHostMethodContext, id?: string) {
  if (!ctx.services.runtimeRpc) {
    throw new PluginHostCallError('unavailable', 'Pipeline runtime unavailable')
  }
  const value = await ctx.services.runtimeRpc(
    id ? 'pipeline.status' : 'pipeline.list',
    id ? { id } : undefined,
    { signal: ctx.scope.signal }
  )
  const result = z
    .object({
      runs: z.array(runSchema).optional(),
      run: runSchema.optional(),
      ready: z.boolean().optional()
    })
    .parse(value)
  const runs = (result.runs ?? (result.run ? [result.run] : [])).filter(
    (run) => run.provider.pluginKey === ctx.pluginId
  )
  if (id && runs.length !== 1) {
    throw new PluginHostCallError(
      'not_permitted',
      'A plugin controls only its own pipeline profiles'
    )
  }
  return { result, runs }
}

const api = PLUGIN_HOST_API
export const PLUGIN_PIPELINE_HANDLERS = {
  'pipeline.read': bind(api['pipeline.read'], async (params, ctx) => {
    const { result, runs } = await read(ctx, params?.id)
    return {
      runs: runs.map((run) => ({
        id: run.id,
        workspaceId: run.workspace.id,
        title: run.profile.title,
        stage: run.stage,
        state: run.state,
        revision: run.revision,
        fixCycles: run.fixCycles,
        reason: run.reason,
        ready: result.ready ?? null
      }))
    }
  }),
  'pipeline.pause': bind(api['pipeline.pause'], async (params, ctx) => {
    await read(ctx, params.id)
    await invokePluginWorkspaceEffect(ctx, 'pipeline.pause', params)
    return { accepted: true as const }
  }),
  'pipeline.resume': bind(api['pipeline.resume'], async (params, ctx) => {
    await read(ctx, params.id)
    await invokePluginWorkspaceEffect(ctx, 'pipeline.resume', params)
    return { accepted: true as const }
  })
}
