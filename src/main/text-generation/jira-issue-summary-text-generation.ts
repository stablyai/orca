import {
  buildJiraIssueSummaryPrompt,
  sanitizeGeneratedJiraIssueSummary,
  type JiraIssueSummaryGenerationContext,
  type JiraIssueSummaryGenerationResult
} from '../../shared/jira-issue-summary-generation'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { runGenerationRequest } from './agent-generation-request'
import type {
  CommitMessageGenerationTarget,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

// Source-control templates and instructions do not apply to Jira issue titles.
export async function generateJiraIssueSummaryFromContext(
  context: JiraIssueSummaryGenerationContext,
  params: ResolvedSourceControlAiGenerationParams,
  target: CommitMessageGenerationTarget,
  spawnAgent: SpawnSourceControlAgent = spawnSourceControlAgent
): Promise<JiraIssueSummaryGenerationResult> {
  const prompt = buildJiraIssueSummaryPrompt(context)
  const result = await runGenerationRequest({
    params,
    prompt,
    target,
    spawnAgent,
    emptyResultName: 'summary',
    operation: 'jira-issue-summary'
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
