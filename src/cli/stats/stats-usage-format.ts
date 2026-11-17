type UsageNumbers = Record<string, number | string | boolean | null | undefined>

export type StatsUsageResult = {
  provider: string
  snapshot: {
    scanState: {
      enabled: boolean
      isScanning: boolean
      lastScanCompletedAt: number | null
      lastScanError: string | null
    }
    summary: UsageNumbers & {
      scope: string
      range: string
      sessions: number
      /** Absent for providers without pricing (Muse). */
      estimatedCostUsd?: number | null
      topModel: string | null
      topProject: string | null
    }
    modelBreakdown: (UsageNumbers & { label: string; estimatedCostUsd?: number | null })[]
  }
}

const TOKEN_FIELDS: [key: string, label: string][] = [
  ['inputTokens', 'input'],
  ['cachedInputTokens', 'cached input'],
  ['cacheReadTokens', 'cache read'],
  ['cacheWriteTokens', 'cache write'],
  ['outputTokens', 'output'],
  ['reasoningOutputTokens', 'reasoning'],
  ['totalTokens', 'total']
]

function formatTokens(row: UsageNumbers): string {
  return TOKEN_FIELDS.filter(([key]) => typeof row[key] === 'number')
    .map(([key, label]) => `${label} ${Number(row[key]).toLocaleString('en-US')}`)
    .join(', ')
}

function formatCost(cost: number | null | undefined): string {
  return typeof cost === 'number' ? `$${cost.toFixed(2)}` : 'n/a'
}

export function formatStatsUsage({ provider, snapshot }: StatsUsageResult): string {
  const { scanState, summary } = snapshot
  const lastScan =
    scanState.lastScanCompletedAt === null
      ? 'never'
      : new Date(scanState.lastScanCompletedAt).toISOString()
  const lines = [
    `${provider} usage (scope ${summary.scope}, range ${summary.range})`,
    `tracking: ${scanState.enabled ? 'on' : 'off'}; last scan: ${lastScan}${scanState.isScanning ? ' (scanning)' : ''}`,
    ...(scanState.lastScanError ? [`last scan error: ${scanState.lastScanError}`] : []),
    `sessions: ${summary.sessions}`,
    `tokens: ${formatTokens(summary) || 'none'}`,
    ...(summary.estimatedCostUsd === undefined
      ? []
      : [
          `estimated cost: ${formatCost(summary.estimatedCostUsd)}${summary.hasUnpricedModels ? ' (some models unpriced)' : ''}`
        ]),
    `top model: ${summary.topModel ?? 'n/a'}; top project: ${summary.topProject ?? 'n/a'}`
  ]
  if (snapshot.modelBreakdown.length > 0) {
    lines.push('', 'by model:')
    for (const row of snapshot.modelBreakdown) {
      const cost =
        row.estimatedCostUsd === undefined ? '' : `; cost ${formatCost(row.estimatedCostUsd)}`
      lines.push(`  ${row.label}: ${formatTokens(row)}${cost}`)
    }
  }
  return lines.join('\n')
}
