import { describe, expect, it, vi } from 'vitest'
import type { ClaudeUsageSummary } from '../../shared/claude-usage-types'
import type { CodexUsageSummary } from '../../shared/codex-usage-types'
import { readHostTokenUsage, type HostTokenUsageSources } from './host-token-usage-summary'

function claudeSummary(overrides: Partial<ClaudeUsageSummary> = {}): ClaudeUsageSummary {
  return {
    scope: 'all',
    range: '30d',
    sessions: 3,
    turns: 10,
    zeroCacheReadTurns: 0,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 400,
    cacheWriteTokens: 20,
    cacheReuseRate: 0.8,
    estimatedCostUsd: 1.25,
    hasUnpricedModels: false,
    topModel: null,
    topProject: null,
    hasAnyClaudeData: true,
    ...overrides
  }
}

function codexSummary(overrides: Partial<CodexUsageSummary> = {}): CodexUsageSummary {
  return {
    scope: 'all',
    range: '30d',
    sessions: 2,
    events: 7,
    inputTokens: 1000,
    cachedInputTokens: 600,
    outputTokens: 80,
    reasoningOutputTokens: 30,
    totalTokens: 1080,
    estimatedCostUsd: null,
    hasUnpricedModels: true,
    topModel: null,
    topProject: null,
    hasAnyCodexData: true,
    ...overrides
  }
}

function sources(args: {
  claudeEnabled?: boolean
  codexEnabled?: boolean
  claude?: ClaudeUsageSummary
  codex?: CodexUsageSummary
}): HostTokenUsageSources {
  const scanState = (enabled: boolean) => ({
    enabled,
    isScanning: false,
    lastScanStartedAt: null,
    lastScanCompletedAt: enabled ? 1_700_000_000_000 : null,
    lastScanError: null
  })
  return {
    claude: {
      getScanState: () => ({ ...scanState(args.claudeEnabled ?? true), hasAnyClaudeData: true }),
      getSummary: vi.fn(async () => args.claude ?? claudeSummary())
    },
    codex: {
      getScanState: () => ({ ...scanState(args.codexEnabled ?? true), hasAnyCodexData: true }),
      getSummary: vi.fn(async () => args.codex ?? codexSummary())
    }
  }
}

describe('readHostTokenUsage', () => {
  it('reports Codex input without cache hits so it sums with Claude field by field', async () => {
    const result = await readHostTokenUsage(sources({}), { range: '30d', scope: 'all' })

    expect(result).toEqual({
      range: '30d',
      scope: 'all',
      providers: [
        {
          provider: 'claude',
          tracking: true,
          lastScanCompletedAt: 1_700_000_000_000,
          sessions: 3,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 400,
          cacheWriteTokens: 20,
          totalTokens: 570,
          estimatedCostUsd: 1.25,
          hasUnpricedModels: false
        },
        {
          provider: 'codex',
          tracking: true,
          lastScanCompletedAt: 1_700_000_000_000,
          sessions: 2,
          inputTokens: 400,
          outputTokens: 80,
          cacheReadTokens: 600,
          cacheWriteTokens: 0,
          totalTokens: 1080,
          estimatedCostUsd: null,
          hasUnpricedModels: true
        }
      ]
    })
  })

  it('passes the requested window to both stores', async () => {
    const usage = sources({})
    await readHostTokenUsage(usage, { range: '7d', scope: 'orca' })

    expect(usage.claude.getSummary).toHaveBeenCalledWith('orca', '7d')
    expect(usage.codex.getSummary).toHaveBeenCalledWith('orca', '7d')
  })

  it('reads tracking after the store has loaded, not from its pre-load default', async () => {
    const usage = sources({})
    let loaded = false
    usage.claude.getScanState = () => ({
      enabled: loaded,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyClaudeData: loaded
    })
    usage.claude.getSummary = vi.fn(async () => {
      loaded = true
      return claudeSummary()
    })

    const result = await readHostTokenUsage(usage, { range: '30d', scope: 'all' })

    expect(result.providers[0]).toMatchObject({ tracking: true, totalTokens: 570 })
  })

  it('marks a provider whose tracking is off instead of reporting stored or zero counts', async () => {
    const usage = sources({ codexEnabled: false })
    const result = await readHostTokenUsage(usage, { range: '30d', scope: 'all' })

    expect(result.providers[1]).toMatchObject({
      provider: 'codex',
      tracking: false,
      sessions: 0,
      totalTokens: 0,
      estimatedCostUsd: null
    })
  })
})
