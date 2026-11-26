import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_WORKSPACE_LIST_LIMIT,
  pluginWorkspaceId
} from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import {
  bind,
  type BoundPluginHostMethod,
  type PluginHostMethodContext
} from './plugin-host-method-bind'
import {
  pluginHostEffect as effect,
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector
} from './plugin-host-runtime-call'
import { resolvePluginProject } from './plugin-host-project-target'
import { PluginHostCallError } from './plugin-host-call-scope'
import { buildWorkspaceRunContext } from '../../../../shared/work-items/task-source-context'
import {
  automationAnswer,
  automationRunsElevated,
  projectPluginAutomations,
  type PluginAutomationRecord
} from './plugin-automation-projection'
import { pluginAutomationRefusal } from './plugin-automation-confirmation'

const api = PLUGIN_HOST_API

const automationListAnswer = z.object({ automations: z.array(automationAnswer) })
const automationCreateAnswer = z.object({ automation: z.object({ id: z.string() }) })
const projectHostSetupAnswer = z.object({
  setups: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      hostId: z.string(),
      repoId: z.string(),
      path: z.string(),
      setupState: z.string()
    })
  )
})
const worktreeListAnswer = z.object({
  worktrees: z.array(
    z.object({ id: z.string(), identity: z.object({ key: z.string() }).optional() })
  )
})

/** The ids `workspace.list` gives the workspaces automations run in. */
async function listedWorkspaceIds(
  ctx: PluginHostMethodContext,
  automations: readonly PluginAutomationRecord[]
): Promise<ReadonlyMap<string, string>> {
  if (!automations.some((automation) => automation.workspaceId)) {
    return new Map()
  }
  const { worktrees } = worktreeListAnswer.parse(
    await rpc(ctx.services)('worktree.list', { limit: PLUGIN_WORKSPACE_LIST_LIMIT })
  )
  return new Map(
    worktrees.map((row) => [
      row.id,
      pluginWorkspaceId({ id: row.id, identityKey: row.identity?.key })
    ])
  )
}

/** Each run in one workspace, whose id also names its host; or in a new one of a project, on
 *  the host `hostId` names: the runtime takes a host only with the project's setup there. */
async function automationTarget(
  ctx: PluginHostMethodContext,
  params: { projectId?: string; hostId?: string; workspaceId?: string }
): Promise<Record<string, unknown>> {
  if (params.workspaceId) {
    return { workspace: workspaceSelector(params.workspaceId), workspaceMode: 'existing' }
  }
  const call = rpc(ctx.services)
  const project = await resolvePluginProject(
    call,
    params.projectId ?? '',
    params.hostId,
    'pass the hostId project.list gives'
  )
  const target = { repo: `id:${project.id}`, workspaceMode: 'new_per_run' }
  if (!project.hostId) {
    return target
  }
  const { setups } = projectHostSetupAnswer.parse(await call('projectHostSetup.list', undefined))
  const setup = setups.find(
    (candidate) =>
      candidate.repoId === project.id &&
      candidate.hostId === project.hostId &&
      candidate.setupState === 'ready'
  )
  const runContext = setup && buildWorkspaceRunContext({ ...setup, projectHostSetupId: setup.id })
  if (!runContext) {
    throw new PluginHostCallError('action_failed', 'this project is not set up on that host')
  }
  return { ...target, runContext }
}

export const PLUGIN_AUTOMATION_HANDLERS = {
  'automation.list': bind(api['automation.list'], async (_params, ctx) => {
    // No selector: every automation this Orca stores, the list `orca automations list` prints.
    const { automations } = automationListAnswer.parse(
      await rpc(ctx.services)('automation.list', {})
    )
    return projectPluginAutomations(
      automations,
      ctx.pluginId,
      await listedWorkspaceIds(ctx, automations)
    )
  }),
  'automation.create': bind(api['automation.create'], async (params, ctx) => {
    const target = await automationTarget(ctx, params)
    // Never forwarded: a precheck (a shell command), agent arguments, launch setup (permission
    // modes), setup decisions or trust, or a destination. Runs use the person's settings for the
    // agent, here. Orca records this plugin as the creator from the caller, not from params.
    const answer = await effect(ctx, 'automation.create', {
      name: params.name.trim(),
      prompt: params.prompt,
      agentId: params.agent,
      ...target,
      rrule: params.schedule,
      dtstart: Date.now(),
      ...(params.timezone ? { timezone: params.timezone } : {}),
      enabled: params.enabled ?? true,
      // Scoped to this plugin, so its keys never answer with another creator's automation.
      ...(params.creationKey ? { creationKey: `plugin:${ctx.pluginId}:${params.creationKey}` } : {})
    })
    return { automationId: automationCreateAnswer.parse(answer).automation.id }
  }),
  'automation.update': bind(api['automation.update'], async (params, ctx) => {
    const { automationId, name, prompt, schedule, timezone, enabled } = params
    const fields = (['name', 'prompt', 'schedule', 'timezone', 'enabled'] as const).filter(
      (field) => params[field] !== undefined
    )
    // Another's automation is the person's. One that runs its agent with extra settings (its
    // arguments, permission mode or a precheck) is asked about even for its own creator when a
    // change would make it run something new: a new prompt, schedule or time zone, or resuming.
    const startsNewRun =
      prompt !== undefined || schedule !== undefined || timezone !== undefined || enabled === true
    const refused = await pluginAutomationRefusal(ctx, automationId, (current, own) => {
      const elevated = automationRunsElevated(current) && startsNewRun
      return own && !elevated
        ? null
        : {
            kind: 'automation.update',
            fields,
            ...(elevated ? { elevated: true } : {}),
            // Whatever the reason to ask, a new prompt is what the person approves.
            ...(prompt !== undefined ? { prompt } : {})
          }
    })
    if (refused) {
      return { updated: false, ...refused }
    }
    await effect(ctx, 'automation.update', {
      id: automationId,
      updates: {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(schedule !== undefined ? { rrule: schedule, dtstart: Date.now() } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(enabled !== undefined ? { enabled } : {})
      }
    })
    return { updated: true }
  }),
  'automation.delete': bind(api['automation.delete'], async ({ automationId }, ctx) => {
    const refused = await pluginAutomationRefusal(ctx, automationId, (_current, own) =>
      own ? null : { kind: 'automation.delete' }
    )
    if (refused) {
      return { deleted: false, ...refused }
    }
    await effect(ctx, 'automation.delete', { id: automationId })
    return { deleted: true }
  })
} satisfies Record<string, BoundPluginHostMethod>
