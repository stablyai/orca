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
import {
  automationAnswer,
  projectPluginAutomations,
  type PluginAutomationRecord
} from './plugin-automation-projection'
import type { PluginConfirmationSubject } from '../../consent/plugin-confirmation-subject'

const api = PLUGIN_HOST_API

const automationListAnswer = z.object({ automations: z.array(automationAnswer) })
const automationShowAnswer = z.object({ automation: automationAnswer })
const automationCreateAnswer = z.object({ automation: z.object({ id: z.string() }) })
const worktreeListAnswer = z.object({
  worktrees: z.array(
    z.object({ id: z.string(), identity: z.object({ key: z.string() }).optional() })
  )
})

type Refusal = { reason: 'cancelled' | 'consent-unavailable' }

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

/**
 * Null when the plugin may go ahead: it created the automation, or the person allowed it. An
 * automation someone else made is the person's, so Orca asks them; headless serve cannot ask.
 */
async function refusalFor(
  ctx: PluginHostMethodContext,
  automationId: string,
  subject: (name: string) => PluginConfirmationSubject
): Promise<Refusal | null> {
  const { automation } = automationShowAnswer.parse(
    await rpc(ctx.services)('automation.show', { id: automationId })
  )
  if (automation.createdBy?.kind === 'plugin' && automation.createdBy.pluginKey === ctx.pluginId) {
    return null
  }
  if (!ctx.services.confirm) {
    return { reason: 'consent-unavailable' }
  }
  const answer = await ctx.services.confirm(ctx.pluginId, subject(automation.name), ctx.scope)
  return answer === 'allowed'
    ? null
    : { reason: answer === 'cancelled' ? 'cancelled' : 'consent-unavailable' }
}

/** Each run in one workspace, whose id also names its host; or in a new one of a project. */
async function automationTarget(
  ctx: PluginHostMethodContext,
  params: { projectId?: string; workspaceId?: string }
): Promise<Record<string, string>> {
  if (params.workspaceId) {
    return { workspace: workspaceSelector(params.workspaceId), workspaceMode: 'existing' }
  }
  const project = await resolvePluginProject(
    rpc(ctx.services),
    params.projectId ?? '',
    undefined,
    'pass workspaceId of a workspace on the host you mean'
  )
  return { repo: `id:${project.id}`, workspaceMode: 'new_per_run' }
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
      enabled: params.enabled ?? true
    })
    return { automationId: automationCreateAnswer.parse(answer).automation.id }
  }),
  'automation.update': bind(api['automation.update'], async (params, ctx) => {
    const { automationId, name, prompt, schedule, timezone, enabled } = params
    const fields = (['name', 'prompt', 'schedule', 'timezone', 'enabled'] as const).filter(
      (field) => params[field] !== undefined
    )
    const refused = await refusalFor(ctx, automationId, (current) => ({
      kind: 'automation.update',
      name: current,
      fields
    }))
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
    const refused = await refusalFor(ctx, automationId, (name) => ({
      kind: 'automation.delete',
      name
    }))
    if (refused) {
      return { deleted: false, ...refused }
    }
    await effect(ctx, 'automation.delete', { id: automationId })
    return { deleted: true }
  })
} satisfies Record<string, BoundPluginHostMethod>
