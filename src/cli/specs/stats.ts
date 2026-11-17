import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

export const STATS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['stats', 'usage'],
    summary: 'Print the Stats & Usage token and cost aggregates for one agent provider',
    usage:
      'orca stats usage --provider claude|codex|opencode|muse [--range 7d|30d|90d|all] [--scope orca|all] [--sessions <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'provider', 'range', 'scope', 'sessions'],
    notes: [
      'Reads the aggregates the Stats & Usage pane already keeps on this Orca host. It does not start a scan, so check scanState.lastScanCompletedAt for freshness and scanState.enabled for whether tracking is on.',
      'Defaults match the pane: --scope orca (sessions in Orca workspaces only), --range 30d, and the 10 most recent sessions. --sessions accepts 0-100.',
      'The JSON result is the same snapshot the pane renders: summary, daily, modelBreakdown, projectBreakdown and recentSessions. Token fields differ by provider; for example Claude reports cacheReadTokens/cacheWriteTokens and Codex reports cachedInputTokens/reasoningOutputTokens.',
      'estimatedCostUsd is an API-price estimate, not billed spend. It is null when nothing in range was priced, and summary.hasUnpricedModels marks models left out of the estimate.'
    ],
    examples: [
      'orca stats usage --provider claude',
      'orca stats usage --provider codex --range 7d --scope all --json',
      "orca stats usage --provider claude --json | jq '.result.snapshot.modelBreakdown'"
    ]
  }
]
