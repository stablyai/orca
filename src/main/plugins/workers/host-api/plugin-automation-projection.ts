import { z } from 'zod'
import type { PluginHostResult } from '../../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_HOST_TEXT_MAX_LENGTH } from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import {
  PLUGIN_AUTOMATION_LIST_LIMIT,
  PLUGIN_AUTOMATION_SCHEDULE_MAX
} from '../../../../shared/plugins/workers/plugin-host-api-automation-methods'

/** The parts of a stored automation plugins may read; the rest (precheck, agent arguments,
 *  launch setup, setup trust, owner) never reaches them. */
export const automationAnswer = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  runContext: z
    .object({ repoId: z.string().optional(), hostId: z.string().optional() })
    .nullable()
    .optional(),
  workspaceMode: z.enum(['existing', 'new_per_run']),
  workspaceId: z.string().nullable(),
  rrule: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number(),
  lastRunAt: z.number().optional(),
  createdBy: z
    .object({
      kind: z.string(),
      pluginKey: z.string().optional(),
      endedAt: z.number().optional()
    })
    .optional(),
  // Read only to tell whether runs use extra agent settings; never projected.
  precheck: z.object({ command: z.string() }).nullable().optional(),
  agentArgs: z.string().nullable().optional(),
  extraAgentArgs: z.string().optional(),
  launchPreferences: z.record(z.string(), z.unknown()).optional()
})
export type PluginAutomationRecord = z.output<typeof automationAnswer>

/** The plugin created it and still owns it: its removal or disabling ends that. */
export function pluginOwnsAutomation(
  automation: PluginAutomationRecord,
  pluginId: string
): boolean {
  const creator = automation.createdBy
  return (
    creator?.kind === 'plugin' && creator.pluginKey === pluginId && creator.endedAt === undefined
  )
}

/** Runs start the agent with more than the person's defaults: arguments, launch choices such as a
 *  permission mode, or a precheck command. Only the person can set these. */
export function automationRunsElevated(automation: PluginAutomationRecord): boolean {
  return Boolean(
    automation.precheck ||
    automation.agentArgs ||
    automation.extraAgentArgs?.trim() ||
    Object.keys(automation.launchPreferences ?? {}).length > 0
  )
}

/** `automation.list`: rows as plugins see them; `workspaceIds` maps raw worktree ids to listed ones. */
export function projectPluginAutomations(
  automations: readonly PluginAutomationRecord[],
  pluginId: string,
  workspaceIds: ReadonlyMap<string, string>
): PluginHostResult<'automation.list'> {
  return {
    automations: automations.slice(0, PLUGIN_AUTOMATION_LIST_LIMIT).map((automation) => {
      const workspaceId =
        automation.workspaceMode === 'existing' && automation.workspaceId
          ? (workspaceIds.get(automation.workspaceId) ?? automation.workspaceId)
          : null
      return {
        id: automation.id,
        name: automation.name.slice(0, 512),
        agent: automation.agentId.slice(0, 64),
        prompt: automation.prompt.slice(0, PLUGIN_HOST_TEXT_MAX_LENGTH),
        promptTruncated: automation.prompt.length > PLUGIN_HOST_TEXT_MAX_LENGTH,
        projectId: automation.runContext?.repoId ?? (automation.projectId || null),
        hostId: automation.runContext?.hostId ?? null,
        workspaceId,
        workspaceMode:
          automation.workspaceMode === 'new_per_run'
            ? ('new-per-run' as const)
            : ('existing' as const),
        schedule: automation.rrule.slice(0, PLUGIN_AUTOMATION_SCHEDULE_MAX),
        timezone: automation.timezone.slice(0, 64),
        enabled: automation.enabled,
        nextRunAt: automation.enabled ? automation.nextRunAt : null,
        lastRunAt: automation.lastRunAt ?? null,
        createdByThisPlugin: pluginOwnsAutomation(automation, pluginId)
      }
    }),
    truncated: automations.length > PLUGIN_AUTOMATION_LIST_LIMIT
  }
}
