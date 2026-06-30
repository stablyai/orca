import type { Automation, AutomationRun, AutomationRunUsage } from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'

export async function collectAutomationRunUsage(input: {
  automation: Automation | undefined
  run: AutomationRun
  claudeUsage: ClaudeUsageStore | null
  codexUsage: CodexUsageStore | null
}): Promise<AutomationRunUsage> {
  const { automation, run, claudeUsage, codexUsage } = input
  const collectedAt = Date.now()
  const unavailable = (
    provider: AutomationRunUsage['provider'],
    unavailableReason: AutomationRunUsage['unavailableReason'],
    unavailableMessage: string
  ): AutomationRunUsage => ({
    status: 'unavailable',
    provider,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    estimatedCostUsd: null,
    estimatedCostSource: null,
    providerSessionId: null,
    attribution: null,
    collectedAt,
    unavailableReason,
    unavailableMessage
  })

  if (!automation || run.status !== 'completed') {
    return unavailable(
      automation?.agentId === 'codex'
        ? 'codex'
        : automation?.agentId === 'claude'
          ? 'claude'
          : null,
      'run_not_finished',
      'Usage is only collected for completed automation runs.'
    )
  }
  if (automation.executionTargetType === 'ssh') {
    return unavailable(
      automation.agentId === 'codex' ? 'codex' : automation.agentId === 'claude' ? 'claude' : null,
      'remote_usage_unavailable',
      'Remote automation usage is not available from local usage logs.'
    )
  }
  if (automation.agentId === 'claude') {
    if (!claudeUsage) {
      return unavailable('claude', 'scan_failed', 'Claude usage store is unavailable.')
    }
    return claudeUsage.getAutomationRunUsage({
      worktreeId: run.workspaceId,
      terminalSessionId: run.terminalSessionId,
      startedAt: run.startedAt,
      completedAt: collectedAt
    })
  }
  if (automation.agentId === 'codex') {
    if (!codexUsage) {
      return unavailable('codex', 'scan_failed', 'Codex usage store is unavailable.')
    }
    return codexUsage.getAutomationRunUsage({
      worktreeId: run.workspaceId,
      terminalSessionId: run.terminalSessionId,
      startedAt: run.startedAt,
      completedAt: collectedAt
    })
  }
  return unavailable(null, 'provider_unsupported', 'This agent does not report usage to Orca yet.')
}
