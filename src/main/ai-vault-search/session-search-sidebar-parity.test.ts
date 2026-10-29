import { afterEach, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { filterAiVaultSessions } from '../../shared/ai-vault-session-filters'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

type Fixture = { id: number; cwd: string; filePath: string; text: string }

const SESSIONS: Fixture[] = [
  {
    id: 1,
    cwd: '/Users/Ada/orca/session-search',
    filePath: '/Users/Ada/.claude/projects/a/one.jsonl',
    text: 'harbor pilot manifest'
  },
  {
    id: 2,
    cwd: '/Users/ada/work/café',
    filePath: '/Users/ada/.codex/sessions/two.jsonl',
    text: 'harbor dock crane'
  },
  {
    id: 3,
    cwd: '/srv/other/service',
    filePath: '/srv/.claude/projects/b/three.jsonl',
    text: 'harbor manifest beta'
  },
  {
    id: 4,
    cwd: 'C:\\Work\\Orca\\App',
    filePath: 'C:\\Users\\Ada\\.claude\\four.jsonl',
    text: 'harbor windows lane'
  },
  {
    id: 5,
    cwd: '/Users/ada/My Project',
    filePath: '/Users/ada/.claude/projects/c/five.jsonl',
    text: 'harbor quay ledger'
  }
]

const QUERIES = [
  'harbor path:jsonl',
  'harbor repo:orca/session-search',
  'harbor path:CAFÉ',
  'harbor path:/Users/Ada/orca',
  'harbor repo:app',
  'harbor repo:Orca/App',
  'harbor path:.codex',
  'harbor path:/srv repo:other/service',
  'harbor repo:session-search path:jsonl',
  'harbor path:"/Users/ada/work"',
  'harbor repo:nothing-here',
  'harbor path:one.jsonl path:two.jsonl',
  'harbor path:"/Users/ada/My Project"',
  'harbor repo:"ada/My Project"',
  'harbor'
]

function asSession(fixture: Fixture): AiVaultSession {
  const at = '2026-09-01T00:00:00.000Z'
  return {
    id: String(fixture.id),
    executionHostId: 'local',
    agent: 'claude',
    sessionId: String(fixture.id),
    title: 'fixture',
    cwd: fixture.cwd,
    branch: null,
    model: null,
    filePath: fixture.filePath,
    codexHome: null,
    createdAt: at,
    updatedAt: at,
    modifiedAt: at,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: fixture.text }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  } as AiVaultSession
}

/** Keep the full query so quoted operator values use the panel’s parser. */
function sidebarIds(query: string): string[] {
  return filterAiVaultSessions(SESSIONS.map(asSession), {
    query,
    agents: ['claude'],
    scope: 'all',
    sort: 'updated',
    activeWorktreePaths: [],
    hideEmptySessions: false
  })
    .map((session) => session.sessionId)
    .sort()
}

it.each(QUERIES)('answers %s the way the sessions panel does', async (query) => {
  harness = await openSessionSearchHarness('ss-sidebar-parity')
  for (const fixture of SESSIONS) {
    addSyntheticSession(harness.db, {
      id: fixture.id,
      cwd: fixture.cwd,
      text: fixture.text,
      filePath: fixture.filePath,
      sessionFilePath: fixture.filePath
    })
  }
  const engineIds = harness.engine
    .search({ query, limit: 100 })
    .hits.map((hit) => hit.sessionId)
    .sort()
  expect(engineIds).toEqual(sidebarIds(query))
})

it('is not vacuous: these queries do select, and reject, real sessions', () => {
  const answers = QUERIES.map((query) => sidebarIds(query).length)
  expect(answers.some((count) => count > 0 && count < SESSIONS.length)).toBe(true)
  expect(answers.some((count) => count === 0)).toBe(true)
})
