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
  createdBy: z.object({ kind: z.string(), pluginKey: z.string().optional() }).optional()
})
export type PluginAutomationRecord = z.output<typeof automationAnswer>

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
        createdByThisPlugin:
          automation.createdBy?.kind === 'plugin' && automation.createdBy.pluginKey === pluginId
      }
    }),
    truncated: automations.length > PLUGIN_AUTOMATION_LIST_LIMIT
  }
}
