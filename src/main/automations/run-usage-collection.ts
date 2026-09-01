import type { Automation, AutomationRun, AutomationRunUsage } from '../../shared/automations-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveTuiAgentBaseAgent } from '../../shared/custom-tui-agents'
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

export type AutomationUsageAgentCatalog = Pick<
  GlobalSettings,
  'customTuiAgents' | 'deletedCustomTuiAgents'
>

/** The built-in harness whose usage logs this automation's runs land in.
 *
 *  Why: usage stores are per-built-in, but `agentId` holds the REQUESTED identity,
 *  so a Codex-based custom agent arrives as its own id. Keyed raw it resolved to no
 *  provider and every such run reported "no usage" — resolve to the base harness
 *  first. A custom the catalog cannot name stays null rather than guessing a base
 *  from the id's syntax. */
function resolveUsageAgent(
  automation: Automation | undefined,
  catalog: AutomationUsageAgentCatalog | undefined
): string | null {
  if (!automation) {
    return null
  }
  return resolveTuiAgentBaseAgent(
    automation.agentId,
    catalog?.customTuiAgents,
    catalog?.deletedCustomTuiAgents
  )
}

function getAutomationUsageProvider(usageAgent: string | null): AutomationRunUsage['provider'] {
  if (usageAgent === 'codex') {
    return 'codex'
  }
  if (usageAgent === 'claude') {
    return 'claude'
  }
  return null
}

export async function collectAutomationRunUsage({
  automation,
  run,
  claudeUsage,
  codexUsage,
  agentCatalog
}: {
  automation: Automation | undefined
  run: AutomationRun
  claudeUsage: ClaudeUsageStore | null
  codexUsage: CodexUsageStore | null
  agentCatalog?: AutomationUsageAgentCatalog
}): Promise<AutomationRunUsage> {
  const collectedAt = Date.now()
  const usageAgent = resolveUsageAgent(automation, agentCatalog)
  const unavailable = (
    provider: AutomationRunUsage['provider'],
    unavailableReason: AutomationRunUsage['unavailableReason'],
    unavailableMessage: string
  ): AutomationRunUsage =>
    createUnavailableAutomationUsage(collectedAt, provider, unavailableReason, unavailableMessage)

  if (!automation || run.status !== 'completed') {
    return unavailable(
      getAutomationUsageProvider(usageAgent),
      'run_not_finished',
      'Usage is only collected for completed automation runs.'
    )
  }
  if (automation.executionTargetType === 'ssh') {
    return unavailable(
      getAutomationUsageProvider(usageAgent),
      'remote_usage_unavailable',
      'Remote automation usage is not available from local usage logs.'
    )
  }
  if (usageAgent === 'claude') {
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
  if (usageAgent === 'codex') {
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
