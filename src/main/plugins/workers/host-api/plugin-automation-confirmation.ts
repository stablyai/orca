import { z } from 'zod'
import { suggestionPathBasename } from '../../../../shared/worktree-name-suggestion'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import type { PluginHostMethodContext } from './plugin-host-method-bind'
import { pluginHostRpc as rpc } from './plugin-host-runtime-call'
import {
  automationAnswer,
  pluginOwnsAutomation,
  type PluginAutomationRecord
} from './plugin-automation-projection'
import type {
  PluginConfirmationAutomation,
  PluginConfirmationSubject
} from '../../consent/plugin-confirmation-subject'

const automationShowAnswer = z.object({ automation: automationAnswer })
const repoListAnswer = z.object({
  repos: z.array(z.object({ id: z.string(), displayName: z.string().optional() }))
})

export type PluginAutomationRefusal = { reason: 'cancelled' | 'consent-unavailable' | 'changed' }

/** What a question asks; Orca adds which automation it is about. */
export type PluginAutomationQuestion = DistributiveOmit<PluginConfirmationSubject, 'automation'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

async function showAutomation(
  ctx: PluginHostMethodContext,
  automationId: string
): Promise<PluginAutomationRecord> {
  return automationShowAnswer.parse(
    await rpc(ctx.services)('automation.show', { id: automationId })
  ).automation
}

/** Which automation this is, as the person can tell it apart from one with the same name. */
async function confirmationIdentity(
  ctx: PluginHostMethodContext,
  automation: PluginAutomationRecord
): Promise<PluginConfirmationAutomation> {
  const projectId = automation.runContext?.repoId ?? automation.projectId
  const { repos } = repoListAnswer.parse(await rpc(ctx.services)('repo.list', {}))
  const workspacePath =
    automation.workspaceMode === 'existing' && automation.workspaceId
      ? (splitWorktreeIdForFilesystem(automation.workspaceId)?.worktreePath ??
        automation.workspaceId)
      : null
  return {
    id: automation.id,
    name: automation.name,
    project: repos.find((repo) => repo.id === projectId)?.displayName || null,
    workspace: workspacePath === null ? null : suggestionPathBasename(workspacePath),
    schedule: automation.rrule
  }
}

/**
 * Null when the plugin may go ahead: `question` asks nothing, or the person allowed it and the
 * automation is still what they were shown. Headless serve cannot ask.
 */
export async function pluginAutomationRefusal(
  ctx: PluginHostMethodContext,
  automationId: string,
  question: (current: PluginAutomationRecord, own: boolean) => PluginAutomationQuestion | null
): Promise<PluginAutomationRefusal | null> {
  const shown = await showAutomation(ctx, automationId)
  const asked = question(shown, pluginOwnsAutomation(shown, ctx.pluginId))
  if (!asked) {
    return null
  }
  if (!ctx.services.confirm) {
    return { reason: 'consent-unavailable' }
  }
  const automation = await confirmationIdentity(ctx, shown)
  const answer = await ctx.services.confirm(ctx.pluginId, { ...asked, automation }, ctx.scope)
  if (answer !== 'allowed') {
    return { reason: answer === 'cancelled' ? 'cancelled' : 'consent-unavailable' }
  }
  // The person answered about the record they saw; one edited meanwhile is another question.
  const now = await showAutomation(ctx, automationId).catch(() => null)
  return now?.updatedAt === shown.updatedAt ? null : { reason: 'changed' }
}
