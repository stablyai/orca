import type { AutomationRunUsage } from '../../shared/automations-types'
import type { CodexUsagePersistedState } from './types'
import { estimateCostUsd } from './codex-usage-cost-estimate'

const AUTOMATION_ATTRIBUTION_WINDOW_MS = 5 * 60_000

export type AutomationUsageLookupInput = {
  worktreeId: string | null
  terminalSessionId: string | null
  startedAt: number | null
  completedAt: number | null
}

type CodexAutomationAttributionDeps = {
  /** Callback, not a snapshot: refresh mutates persisted state in place. */
  getState: () => CodexUsagePersistedState
  refresh: (force: boolean) => Promise<{ lastScanError: string | null }>
}

function shouldForceAutomationUsageScan(
  scanState: CodexUsagePersistedState['scanState'],
  completedAt: number
): boolean {
  const { lastScanCompletedAt, lastScanError } = scanState
  // Why: attribution needs a scan after the run finishes, but repeated
  // lookups after that point should not rescan all Codex session history.
  return Boolean(lastScanError) || lastScanCompletedAt === null || lastScanCompletedAt < completedAt
}

export async function resolveCodexAutomationRunUsage(
  input: AutomationUsageLookupInput,
  deps: CodexAutomationAttributionDeps
): Promise<AutomationRunUsage> {
  const collectedAt = Date.now()
  const unavailable = (
    unavailableReason: AutomationRunUsage['unavailableReason'],
    unavailableMessage: string
  ): AutomationRunUsage => ({
    status: 'unavailable',
    provider: 'codex',
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

  if (!deps.getState().scanState.enabled) {
    return unavailable('usage_not_enabled', 'Codex usage tracking is not enabled.')
  }
  if (!input.worktreeId || !input.startedAt || !input.completedAt) {
    return unavailable('no_matching_session', 'Run session metadata is incomplete.')
  }

  const scanState = await deps.refresh(
    shouldForceAutomationUsageScan(deps.getState().scanState, input.completedAt)
  )
  if (scanState.lastScanError) {
    return unavailable('scan_failed', scanState.lastScanError)
  }

  const windowStart = input.startedAt - AUTOMATION_ATTRIBUTION_WINDOW_MS
  const windowEnd = input.completedAt + AUTOMATION_ATTRIBUTION_WINDOW_MS
  const candidates = deps.getState().sessions.filter((session) => {
    const first = new Date(session.firstTimestamp).getTime()
    const last = new Date(session.lastTimestamp).getTime()
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      return false
    }
    if (session.sessionId === input.terminalSessionId) {
      return true
    }
    if (first < windowStart || first > windowEnd || last > windowEnd) {
      return false
    }
    return session.locationBreakdown.some((entry) => entry.worktreeId === input.worktreeId)
  })

  if (candidates.length === 0) {
    return unavailable('no_matching_session', 'No Codex usage session matched this run.')
  }
  if (candidates.length > 1) {
    return unavailable(
      'ambiguous_session',
      'Multiple Codex usage sessions matched this run window.'
    )
  }

  const session = candidates[0]
  const scopedLocations = session.locationBreakdown.filter(
    (entry) => entry.worktreeId === input.worktreeId
  )
  const locations = scopedLocations.length > 0 ? scopedLocations : session.locationBreakdown
  const totals = locations.reduce(
    (acc, entry) => {
      acc.events += entry.eventCount
      acc.inputTokens += entry.inputTokens
      acc.cachedInputTokens += entry.cachedInputTokens
      acc.outputTokens += entry.outputTokens
      acc.reasoningOutputTokens += entry.reasoningOutputTokens
      acc.totalTokens += entry.totalTokens
      return acc
    },
    {
      events: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    }
  )
  const scopedModelRows = session.locationModelBreakdown.filter(
    (entry) => entry.worktreeId === input.worktreeId
  )
  const modelRows = scopedModelRows.length > 0 ? scopedModelRows : session.modelBreakdown
  const modelLabels = [...new Set(modelRows.map((entry) => entry.modelLabel))]
  let estimatedCostUsd = 0
  let hasKnownCost = false
  if (scopedModelRows.length > 0) {
    for (const modelRow of scopedModelRows) {
      const cost = estimateCostUsd(
        modelRow.modelKey,
        modelRow.inputTokens,
        modelRow.cachedInputTokens,
        modelRow.outputTokens
      )
      if (cost !== null) {
        hasKnownCost = true
        estimatedCostUsd += cost
      }
    }
  } else if (!session.hasMixedModels) {
    const cost = estimateCostUsd(
      session.primaryModel,
      totals.inputTokens,
      totals.cachedInputTokens,
      totals.outputTokens
    )
    if (cost !== null) {
      hasKnownCost = true
      estimatedCostUsd += cost
    }
  }

  return {
    status: 'known',
    provider: 'codex',
    model:
      modelLabels.length === 1
        ? modelLabels[0]
        : session.hasMixedModels
          ? 'Mixed models'
          : session.primaryModel,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cachedInputTokens,
    cacheWriteTokens: null,
    reasoningOutputTokens: totals.reasoningOutputTokens,
    totalTokens: totals.totalTokens,
    estimatedCostUsd: hasKnownCost ? estimatedCostUsd : null,
    estimatedCostSource: hasKnownCost ? 'api_equivalent' : null,
    providerSessionId: session.sessionId,
    // Why: Orca terminal tab ids and Codex usage session ids are different
    // systems today, so attribution is intentionally limited to one local
    // provider session in the run's worktree/time window.
    attribution: 'provider_session_time_window',
    collectedAt,
    unavailableReason: null,
    unavailableMessage: null
  }
}
