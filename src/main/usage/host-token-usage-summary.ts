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

async function readProvider<TSummary>(
  provider: HostTokenUsageProvider,
  source: {
    getScanState(): { enabled: boolean; lastScanCompletedAt: number | null }
    getSummary(scope: HostTokenUsageScope, range: HostTokenUsageRange): Promise<TSummary>
  },
  params: { range: HostTokenUsageRange; scope: HostTokenUsageScope },
  toCounts: (summary: TSummary) => TokenCounts
): Promise<HostTokenUsageProviderRow> {
  // getSummary waits for the persisted store to load; scan state read earlier is the pre-load default.
  const summary = await source.getSummary(params.scope, params.range)
  const scanState = source.getScanState()
  const counts = scanState.enabled ? toCounts(summary) : UNTRACKED
  return {
    provider,
    tracking: scanState.enabled,
    lastScanCompletedAt: scanState.lastScanCompletedAt,
    ...counts,
    totalTokens:
      counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens
  }
}

/** This host's own token usage; never turns tracking on, since that starts reading local transcripts. */
export async function readHostTokenUsage(
  sources: HostTokenUsageSources,
  params: { range: HostTokenUsageRange; scope: HostTokenUsageScope }
): Promise<HostTokenUsageSummary> {
  const { range, scope } = params
  const providers = await Promise.all([
    readProvider('claude', sources.claude, params, (summary) => ({
      sessions: summary.sessions,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheReadTokens: summary.cacheReadTokens,
      cacheWriteTokens: summary.cacheWriteTokens,
      estimatedCostUsd: summary.estimatedCostUsd,
      hasUnpricedModels: summary.hasUnpricedModels
    })),
    readProvider('codex', sources.codex, params, (summary) => ({
      sessions: summary.sessions,
      // Codex counts cache hits inside input; Claude reports them separately.
      inputTokens: summary.inputTokens - summary.cachedInputTokens,
      outputTokens: summary.outputTokens,
      cacheReadTokens: summary.cachedInputTokens,
      cacheWriteTokens: 0,
      estimatedCostUsd: summary.estimatedCostUsd,
      hasUnpricedModels: summary.hasUnpricedModels
    }))
  ])
  return { range, scope, providers }
}
