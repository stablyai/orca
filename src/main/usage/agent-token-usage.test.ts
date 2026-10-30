import { describe, expect, it } from 'vitest'
import type { ClaudeUsageSession } from '../claude-usage/types'
import type { CodexUsageSession } from '../codex-usage/types'
import type { OpenCodeUsageSession } from '../opencode-usage/types'
import { claudeTokenSessions, codexOpenCodeTokenSessions } from './agent-token-usage'

const claudeLocation = {
  locationKey: '/private/path',
  projectLabel: 'private-repo',
  repoId: 'repo',
  worktreeId: 'folder',
  turnCount: 1,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 10,
  cacheWrite1hTokens: 5
}
const claude: ClaudeUsageSession = {
  sessionId: 'session',
  firstTimestamp: 'private-start',
  lastTimestamp: 'private-end',
  model: 'private-model',
  lastCwd: '/private/path',
  lastGitBranch: 'private-branch',
  primaryWorktreeId: 'folder',
  primaryRepoId: 'repo',
  turnCount: 2,
  totalInputTokens: 200,
  totalOutputTokens: 40,
  totalCacheReadTokens: 60,
  totalCacheWriteTokens: 20,
  totalCacheWrite1hTokens: 10,
  locationBreakdown: [claudeLocation, { ...claudeLocation, worktreeId: null }]
}
const codexLocation = {
  locationKey: '/private/path',
  projectLabel: 'private-repo',
  repoId: 'repo',
  worktreeId: 'folder',
  eventCount: 1,
  inputTokens: 100,
  cachedInputTokens: 30,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  totalTokens: 120,
  hasInferredPricing: false,
  longContextInputTokens: 0,
  longContextCachedInputTokens: 0,
  longContextOutputTokens: 0,
  estimatedCostUsd: 1
}
const codex: CodexUsageSession = {
  sessionId: 'session',
  firstTimestamp: 'private-start',
  lastTimestamp: 'private-end',
  primaryModel: 'private-model',
  hasMixedModels: false,
  primaryProjectLabel: 'private-repo',
  hasMixedLocations: true,
  primaryWorktreeId: 'folder',
  primaryRepoId: 'repo',
  eventCount: 2,
  totalInputTokens: 200,
  totalCachedInputTokens: 60,
  totalOutputTokens: 40,
  totalReasoningOutputTokens: 10,
  totalTokens: 240,
  hasInferredPricing: false,
  longContextInputTokens: 0,
  longContextCachedInputTokens: 0,
  longContextOutputTokens: 0,
  locationBreakdown: [codexLocation, { ...codexLocation, worktreeId: null }],
  modelBreakdown: [],
  locationModelBreakdown: []
}
const opencode: OpenCodeUsageSession = {
  ...codex,
  estimatedCostUsd: 2,
  locationBreakdown: [codexLocation, { ...codexLocation, worktreeId: null }],
  modelBreakdown: [],
  locationModelBreakdown: []
}

describe('Orca token projections', () => {
  it('counts Claude cache writes once including the 1-hour subset and excludes outside usage', () => {
    expect(claudeTokenSessions([claude])).toEqual([
      {
        providerSessionId: 'session',
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 30,
        cache_write_input_tokens: 10
      }
    ])
  })
  it.each([codex, opencode])('separates cache reads from inclusive input counts', (session) => {
    expect(codexOpenCodeTokenSessions([session])).toEqual([
      {
        providerSessionId: 'session',
        input_tokens: 70,
        output_tokens: 20,
        cached_input_tokens: 30,
        cache_write_input_tokens: 0
      }
    ])
  })
  it('does not fall back to unscoped session totals when attribution is missing', () => {
    expect(claudeTokenSessions([{ ...claude, locationBreakdown: [] }])).toEqual([])
    expect(codexOpenCodeTokenSessions([{ ...codex, locationBreakdown: [] }])).toEqual([])
    expect(
      codexOpenCodeTokenSessions([
        { ...codex, locationBreakdown: [{ ...codexLocation, worktreeId: null }] }
      ])
    ).toEqual([])
  })
})
