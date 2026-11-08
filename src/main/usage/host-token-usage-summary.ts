import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type {
  HostTokenUsageProvider,
  HostTokenUsageProviderRow,
  HostTokenUsageRange,
  HostTokenUsageScope,
  HostTokenUsageSummary
} from '../../shared/host-token-usage-types'

export type HostTokenUsageSources = {
  claude: Pick<ClaudeUsageStore, 'getScanState' | 'getSummary'>
  codex: Pick<CodexUsageStore, 'getScanState' | 'getSummary'>
}

type TokenCounts = Pick<
  HostTokenUsageProviderRow,
  | 'sessions'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'estimatedCostUsd'
  | 'hasUnpricedModels'
>

const UNTRACKED: TokenCounts = {
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: null,
  hasUnpricedModels: false
}

function toRow(
  provider: HostTokenUsageProvider,
  scanState: { enabled: boolean; lastScanCompletedAt: number | null },
  counts: TokenCounts
): HostTokenUsageProviderRow {
  return {
    provider,
    tracking: scanState.enabled,
    lastScanCompletedAt: scanState.lastScanCompletedAt,
    ...counts,
    totalTokens:
      counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens
  }
}

async function readClaude(
  source: HostTokenUsageSources['claude'],
  scope: HostTokenUsageScope,
  range: HostTokenUsageRange
): Promise<HostTokenUsageProviderRow> {
  if (!source.getScanState().enabled) {
    return toRow('claude', source.getScanState(), UNTRACKED)
  }
  const summary = await source.getSummary(scope, range)
  return toRow('claude', source.getScanState(), {
    sessions: summary.sessions,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
    estimatedCostUsd: summary.estimatedCostUsd,
    hasUnpricedModels: summary.hasUnpricedModels
  })
}

async function readCodex(
  source: HostTokenUsageSources['codex'],
  scope: HostTokenUsageScope,
  range: HostTokenUsageRange
): Promise<HostTokenUsageProviderRow> {
  if (!source.getScanState().enabled) {
    return toRow('codex', source.getScanState(), UNTRACKED)
  }
  const summary = await source.getSummary(scope, range)
  return toRow('codex', source.getScanState(), {
    sessions: summary.sessions,
    // Codex counts cache hits inside input; Claude reports them separately.
    inputTokens: summary.inputTokens - summary.cachedInputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cachedInputTokens,
    cacheWriteTokens: 0,
    estimatedCostUsd: summary.estimatedCostUsd,
    hasUnpricedModels: summary.hasUnpricedModels
  })
}

/** This host's own token usage; never turns tracking on, since that starts reading local transcripts. */
export async function readHostTokenUsage(
  sources: HostTokenUsageSources,
  params: { range: HostTokenUsageRange; scope: HostTokenUsageScope }
): Promise<HostTokenUsageSummary> {
  const { range, scope } = params
  const providers = await Promise.all([
    readClaude(sources.claude, scope, range),
    readCodex(sources.codex, scope, range)
  ])
  return { range, scope, providers }
}
