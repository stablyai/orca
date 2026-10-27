import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { codexOpenCodeTokenSessions } from '../usage/agent-token-usage'
import { createUsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { getDefaultState, normalizePersistedState } from './persisted-state-normalization'
import { writeOpenCodeUsageDatabase } from './opencode-usage-sqlite-fixture'
import { parseOpenCodeUsageDatabase } from './scanner'
import { parseOpenCodeUsageRow } from './opencode-usage-row-parsing'

it.each([
  { input: 638, read: 642944, write: 1024, total: 644706 },
  { input: 0, read: 0, write: 1024, total: 1124 }
])(
  'preserves cache writes and uncached input in $total tokens',
  ({ input, read, write, total }) => {
    const parsed = parseOpenCodeUsageRow({
      id: 'cache-write-message',
      session_id: 'cache-write-session',
      time_created: 1_777_777_700_000,
      time_updated: null,
      directory: null,
      title: null,
      worktree: null,
      session_model: null,
      data: JSON.stringify({
        tokens: { input, output: 100, reasoning: 0, total, cache: { read, write } }
      })
    })
    expect(parsed).toMatchObject({
      inputTokens: input + read + write,
      cachedInputTokens: read + write,
      cacheWriteInputTokens: write,
      outputTokens: 100,
      totalTokens: total
    })
    expect((parsed?.inputTokens ?? 0) - (parsed?.cachedInputTokens ?? 0)).toBe(input)
  }
)

it.each(['v1', 'v2-only'] as const)(
  'preserves separate cache read and write telemetry after %s aggregation and reload',
  async (generation) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cache-buckets-')))
    try {
      const path = join(directory, 'opencode.db')
      const sessions = [
        {
          id: 'cache-session',
          directory,
          tokensInput: 638,
          tokensOutput: 100,
          tokensCacheRead: 642944,
          tokensCacheWrite: 1024
        }
      ]
      writeOpenCodeUsageDatabase(path, {
        generation,
        legacySessions: sessions,
        v2Sessions: sessions,
        worktree: directory
      })
      const resolver = await createUsageWorktreeResolver([
        {
          repoId: 'repo',
          worktreeId: 'folder',
          path: directory,
          displayName: 'Repo'
        }
      ])
      const database = await parseOpenCodeUsageDatabase(path, resolver)
      const state = normalizePersistedState({
        ...getDefaultState(),
        processedDatabases: [structuredClone(database)],
        sessions: structuredClone(database.sessions),
        dailyAggregates: structuredClone(database.dailyAggregates)
      })
      expect(state.dailyAggregates[0]).toMatchObject({
        inputTokens: 644606,
        cachedInputTokens: 643968,
        cacheWriteInputTokens: 1024
      })
      expect(state.sessions[0]?.modelBreakdown[0]?.cacheWriteInputTokens).toBe(1024)
      expect(state.sessions[0]?.locationModelBreakdown[0]?.cacheWriteInputTokens).toBe(1024)
      for (const sessions of [state.sessions, state.processedDatabases[0]?.sessions ?? []]) {
        expect(codexOpenCodeTokenSessions(sessions)).toEqual([
          {
            providerSessionId: 'cache-session',
            input_tokens: 638,
            output_tokens: 100,
            cached_input_tokens: 642944,
            cache_write_input_tokens: 1024
          }
        ])
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
