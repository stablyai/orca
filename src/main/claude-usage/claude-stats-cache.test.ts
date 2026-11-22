import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ClaudeStatsCacheHomeRef } from '../../shared/agent-usage/analytics/claude-usage-types'
import { readClaudeStatsCaches } from './claude-stats-cache'

function modelUsage(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    webSearchRequests: 0,
    costUSD: 0
  }
}

function statsCache(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 5,
    lastComputedDate: '2026-01-02',
    modelUsage: { 'model-a': modelUsage(1, 2, 30, 4), 'model-b': modelUsage(10, 20, 300, 40) },
    totalSessions: 3,
    ...overrides
  })
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-stats-cache-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// Fresh folder per call: the parse cache is keyed by path and lives for the module.
function writeHome(name: string, contents: string): ClaudeStatsCacheHomeRef {
  const home = join(root, name)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'stats-cache.json'), contents)
  return { home, label: name }
}

it('sums the four token categories across models and accepts a newer version of the same shape', async () => {
  const v5 = writeHome('v5', statsCache())
  const v6 = writeHome('v6', statsCache({ version: 6 }))
  expect(await readClaudeStatsCaches([v5, v6])).toEqual([
    {
      configHome: v5.home,
      label: 'v5',
      status: 'ok',
      totalTokens: 407,
      lastComputedDate: '2026-01-02'
    },
    {
      configHome: v6.home,
      label: 'v6',
      status: 'ok',
      totalTokens: 407,
      lastComputedDate: '2026-01-02'
    }
  ])
})

it.each([
  ['an older version', statsCache({ version: 4 }), 'unsupported-version'],
  [
    'a newer version with a changed shape',
    statsCache({ version: 6, modelUsage: [] }),
    'unsupported-version'
  ],
  ['a negative count', statsCache({ modelUsage: { m: modelUsage(-1, 0, 0, 0) } }), 'invalid'],
  [
    'counts that overflow',
    statsCache({ modelUsage: { m: modelUsage(1e308, 1e308, 0, 0) } }),
    'invalid'
  ],
  ['truncated JSON', '{"version":5,', 'invalid'],
  ['a file over the size cap', ' '.repeat(4 * 1024 * 1024 + 1), 'too-large']
])('reports %s as unavailable rather than a total', async (name, contents, reason) => {
  const ref = writeHome(name, contents)
  expect(await readClaudeStatsCaches([ref])).toEqual([
    { configHome: ref.home, label: name, status: 'unavailable', reason }
  ])
})

it('keeps one row per shared history, from the cache that saw the most of it', async () => {
  const defaultHome = writeHome('.claude', statsCache({ lastComputedDate: '2026-01-01' }))
  mkdirSync(join(defaultHome.home, 'projects'))
  // Newer but smaller: the account home never saw days whose transcripts were deleted earlier.
  const accountHome = writeHome(
    'acct',
    statsCache({ lastComputedDate: '2026-01-05', modelUsage: { m: modelUsage(1, 2, 3, 4) } })
  )
  symlinkSync(join(defaultHome.home, 'projects'), join(accountHome.home, 'projects'), 'junction')
  const separate = writeHome('separate', statsCache({ modelUsage: { m: modelUsage(1, 1, 1, 1) } }))

  expect(await readClaudeStatsCaches([accountHome, defaultHome, separate])).toMatchObject([
    { configHome: defaultHome.home, totalTokens: 407, lastComputedDate: '2026-01-01' },
    { configHome: separate.home, totalTokens: 4 }
  ])
})

it('treats a projects link whose target does not exist yet as the same history', async () => {
  const defaultHome = writeHome('.claude', statsCache({ lastComputedDate: '2026-01-05' }))
  const accountHome = writeHome('acct', statsCache({ lastComputedDate: '2026-01-01' }))
  symlinkSync(join(defaultHome.home, 'projects'), join(accountHome.home, 'projects'), 'junction')

  expect(await readClaudeStatsCaches([accountHome, defaultHome])).toMatchObject([
    { configHome: defaultHome.home, lastComputedDate: '2026-01-05' }
  ])
})
