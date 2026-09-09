import { expect, it } from 'vitest'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { sessionSearchDiscoveredCounts } from './session-search-discovered-counts'

function discovery(agent: SessionFileDiscovery['agent'], files: number): SessionFileDiscovery {
  return {
    agent,
    rootDir: `/roots/${agent}`,
    files: Array.from({ length: files }, (_unused, index) => ({
      path: `/roots/${agent}/${index}.jsonl`,
      mtimeMs: 0,
      modifiedAt: new Date(0).toISOString()
    }))
  }
}

it('keeps a provider whose every read failed apart from one that is not installed', () => {
  const counts = sessionSearchDiscoveredCounts(
    [discovery('claude', 2), discovery('claude', 1), discovery('codex', 0)],
    [
      { agent: 'codex', path: '/roots/codex', message: 'unreadable' },
      { agent: 'gemini', path: '/roots/gemini', message: 'unreadable' },
      { agent: 'claude', path: '/roots/claude', kind: 'notice', message: 'list truncated' }
    ]
  )
  expect(Object.fromEntries(counts)).toEqual({
    claude: { files: 3, failures: 0 },
    codex: { files: 0, failures: 1 },
    gemini: { files: 0, failures: 1 }
  })
})
