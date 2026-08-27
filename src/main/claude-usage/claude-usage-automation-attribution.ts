import type { AutomationRunUsage } from '../../shared/automations-types'
import type { ClaudeUsagePersistedState } from './types'
import { estimateCostUsd } from './claude-model-pricing'

const AUTOMATION_ATTRIBUTION_WINDOW_MS = 5 * 60_000

export type AutomationUsageLookupInput = {
  worktreeId: string | null
  terminalSessionId: string | null
  startedAt: number | null
  completedAt: number | null
}

type ClaudeUsageStateAccess = {
  getState: () => ClaudeUsagePersistedState
  refresh: (force: boolean) => Promise<{ lastScanError: string | null }>
}

function shouldForceAutomationUsageScan(
  state: ClaudeUsagePersistedState,
  completedAt: number
): boolean {
  const { lastScanCompletedAt, lastScanError } = state.scanState
  // Why: attribution needs a scan after the run finishes, but repeated
  // lookups after that point should not rescan all Claude transcript history.
  return Boolean(lastScanError) || lastScanCompletedAt === null || lastScanCompletedAt < completedAt
}

export async function resolveAutomationRunUsage(
  input: AutomationUsageLookupInput,
  access: ClaudeUsageStateAccess
): Promise<AutomationRunUsage> {
  const collectedAt = Date.now()
  const unavailable = (
    unavailableReason: AutomationRunUsage['unavailableReason'],
    unavailableMessage: string
  ): AutomationRunUsage => ({
    status: 'unavailable',
    provider: 'claude',
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

  if (!access.getState().scanState.enabled) {
    return unavailable('usage_not_enabled', 'Claude usage tracking is not enabled.')
  }
  if (!input.worktreeId || !input.startedAt || !input.completedAt) {
    return unavailable('no_matching_session', 'Run session metadata is incomplete.')
  }

  const scanState = await access.refresh(
    shouldForceAutomationUsageScan(access.getState(), input.completedAt)
  )
  if (scanState.lastScanError) {
    return unavailable('scan_failed', scanState.lastScanError)
  }

  const windowStart = input.startedAt - AUTOMATION_ATTRIBUTION_WINDOW_MS
  const windowEnd = input.completedAt + AUTOMATION_ATTRIBUTION_WINDOW_MS
  const candidates = access.getState().sessions.filter((session) => {
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
    return unavailable('no_matching_session', 'No Claude usage session matched this run.')
  }
  if (candidates.length > 1) {
    return unavailable(
      'ambiguous_session',
      'Multiple Claude usage sessions matched this run window.'
    )
  }

  const session = candidates[0]
  const scopedLocations = session.locationBreakdown.filter(
    (entry) => entry.worktreeId === input.worktreeId
  )
  const locations = scopedLocations.length > 0 ? scopedLocations : session.locationBreakdown
  const totals = locations.reduce(
    (acc, entry) => {
      acc.turns += entry.turnCount
      acc.inputTokens += entry.inputTokens
      acc.outputTokens += entry.outputTokens
      acc.cacheReadTokens += entry.cacheReadTokens
      acc.cacheWriteTokens += entry.cacheWriteTokens
      return acc
    },
    {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  )
  const estimatedCostUsd = estimateCostUsd(
    session.model,
    totals.inputTokens,
    totals.outputTokens,
    totals.cacheReadTokens,
    totals.cacheWriteTokens
  )

  return {
    status: 'known',
    provider: 'claude',
    model: session.model,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    reasoningOutputTokens: null,
    totalTokens:
      totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    estimatedCostUsd,
    estimatedCostSource: estimatedCostUsd === null ? null : 'api_equivalent',
    providerSessionId: session.sessionId,
    // Why: Orca terminal tab ids and Claude usage session ids are different
    // systems today, so attribution is intentionally limited to one local
    // provider session in the run's worktree/time window.
    attribution: 'provider_session_time_window',
    collectedAt,
    unavailableReason: null,
    unavailableMessage: null
  }
}
