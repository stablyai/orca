import type { Automation, AutomationRun, AutomationRunUsage } from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { AutomationRunWriter } from './automation-run-writer'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'

function createUnavailableAutomationUsage(
  collectedAt: number,
  provider: AutomationRunUsage['provider'],
  unavailableReason: AutomationRunUsage['unavailableReason'],
  unavailableMessage: string
): AutomationRunUsage {
  return {
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
  }
}

function getAutomationUsageProvider(
  automation: Automation | undefined
): AutomationRunUsage['provider'] {
  if (automation?.agentId === 'codex') {
    return 'codex'
  }
  if (automation?.agentId === 'claude') {
    return 'claude'
  }
  return null
}

export async function collectAutomationRunUsage({
  automation,
  run,
  claudeUsage,
  codexUsage
}: {
  automation: Automation | undefined
  run: AutomationRun
  claudeUsage: ClaudeUsageStore | null
  codexUsage: CodexUsageStore | null
}): Promise<AutomationRunUsage> {
  const collectedAt = Date.now()
  const unavailable = (
    provider: AutomationRunUsage['provider'],
    unavailableReason: AutomationRunUsage['unavailableReason'],
    unavailableMessage: string
  ): AutomationRunUsage =>
    createUnavailableAutomationUsage(collectedAt, provider, unavailableReason, unavailableMessage)

  if (!automation || run.status !== 'completed') {
    return unavailable(
      getAutomationUsageProvider(automation),
      'run_not_finished',
      'Usage is only collected for completed automation runs.'
    )
  }
  if (automation.executionTargetType === 'ssh') {
    return unavailable(
      getAutomationUsageProvider(automation),
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

/** Collects and writes the usage a just-finalized run earned, returning the row to answer with. */
export async function writeAutomationRunUsage(input: {
  store: Store
  runs: AutomationRunWriter
  run: AutomationRun
  claudeUsage: ClaudeUsageStore | null
  codexUsage: CodexUsageStore | null
}): Promise<AutomationRun> {
  const { store, run } = input
  const usage = await collectAutomationRunUsage({
    automation: store.listAutomations().find((entry) => entry.id === run.automationId),
    run,
    claudeUsage: input.claudeUsage,
    codexUsage: input.codexUsage
  })
  // Why: the run is final during the await above, so a concurrent create-time
  // retention prune may have evicted it — the usage write must not throw then.
  if (!store.listAutomationRuns(run.automationId).some((entry) => entry.id === run.id)) {
    return run
  }
  return input.runs.updateRun({
    runId: run.id,
    status: run.status,
    workspaceId: run.workspaceId,
    terminalSessionId: run.terminalSessionId,
    usage,
    error: run.error
  })
}
