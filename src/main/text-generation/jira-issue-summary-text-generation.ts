import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import {
  buildJiraIssueSummaryPrompt,
  sanitizeGeneratedJiraIssueSummary,
  type JiraIssueSummaryGenerationContext,
  type JiraIssueSummaryGenerationResult
} from '../../shared/jira-issue-summary-generation'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { runLocalPlanForAgent } from './source-control-local-generation'
import { runRemoteSourceControlPlan } from './source-control-remote-generation'
import { commandBackslashMode } from './source-control-text-generation-requests'
import type {
  CommitMessageGenerationTarget,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

/**
 * Generates a Jira issue summary (title) from the drafted description.
 * Deliberately ignores the params' command template and custom instructions —
 * those are authored for source-control naming, not Jira titles.
 */
export async function generateJiraIssueSummaryFromContext(
  context: JiraIssueSummaryGenerationContext,
  params: ResolvedSourceControlAiGenerationParams,
  target: CommitMessageGenerationTarget,
  spawnAgent: SpawnSourceControlAgent = spawnSourceControlAgent
): Promise<JiraIssueSummaryGenerationResult> {
  const prompt = buildJiraIssueSummaryPrompt(context)
  const planned = planCommitMessageGeneration(
    { ...params, backslash: commandBackslashMode(target) },
    prompt
  )
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const result =
    target.kind === 'remote'
      ? await runRemoteSourceControlPlan({
          plan: planned.plan,
          target,
          emptyResultName: 'summary',
          operation: 'jira-issue-summary'
        })
      : await runLocalPlanForAgent({
          agentId: params.agentId,
          plan: planned.plan,
          target,
          emptyResultName: 'summary',
          operation: 'jira-issue-summary',
          spawnAgent
        })
  if (!result.success) {
    return { success: false, error: result.error, canceled: result.canceled }
  }
  const summary = sanitizeGeneratedJiraIssueSummary(result.rawOutput)
  return summary
    ? { success: true, summary, agentLabel: result.agentLabel }
    : { success: false, error: 'Generated summary was empty after sanitization.' }
}

export function cancelGenerateJiraIssueSummaryLocal(cwd: string): void {
  cancelLocalGeneration('jira-issue-summary', cwd)
}
