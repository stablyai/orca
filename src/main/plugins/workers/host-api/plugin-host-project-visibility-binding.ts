import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import { pluginHostEffect as effect, pluginHostRpc as rpc } from './plugin-host-runtime-call'
import { resolvePluginProject } from './plugin-host-project-target'

// Optional: a host that predates hidden projects answers without `hidden`, which must read as a
// refusal, never as done.
const repoSetHiddenAnswer = z.object({ hidden: z.boolean().optional() })

export const PLUGIN_PROJECT_VISIBILITY_HANDLERS = {
  'project.setHidden': bind(PLUGIN_HOST_API['project.setHidden'], async (params, ctx) => {
    const project = await resolvePluginProject(
      rpc(ctx.services),
      params.projectId,
      params.hostId,
      'pass the hostId project.list gives'
    )
    // By id on the one host found: a name or path could pick another project, and a bare id
    // another host's copy.
    const { hidden } = repoSetHiddenAnswer.parse(
      await effect(ctx, 'repo.setHidden', {
        repo: `id:${project.id}`,
        repoHostId: project.ownerHostId,
        hidden: params.hidden
      })
    )
    if (hidden !== params.hidden) {
      throw new PluginHostCallError(
        'action_failed',
        "this project's host could not change it; it may need an Orca update"
      )
    }
    return { hostId: project.ownerHostId, hidden }
  })
} satisfies Record<string, BoundPluginHostMethod>
