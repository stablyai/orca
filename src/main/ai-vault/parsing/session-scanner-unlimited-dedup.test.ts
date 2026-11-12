import { beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'

const fixture = vi.hoisted((): { sessions: AiVaultSession[] } => ({
  sessions: []
}))
vi.mock('../discovery/session-scanner-source-discovery', () => ({
  discoverAiVaultSessionSources: async () => [],
  DEFAULT_CODEX_HOME_DIR: '/fixture'
}))
vi.mock('../discovery/session-scanner-candidates', () => ({
  sessionCandidatesFromDiscoveries: async () => candidates()
}))
vi.mock('../parse-cache/session-scanner-parse-cache', () => ({
  createSessionParseStats: () => ({
    reused: 0,
    incremental: 0,
    fullParses: 0,
    earlyStopped: 0,
    bytesRead: 0
  }),
  parseListedSessionFile: async (candidate: { session: AiVaultSession }) => candidate.session
}))

import { scanAiVaultSessions } from '../session-scanner'
import { ScannedSessionCollection } from './session-root-dedup'

function candidates() {
  return fixture.sessions.map((session) => ({
    agent: session.agent,
    file: { path: session.filePath, mtimeMs: Date.parse(session.modifiedAt) },
    codexHome: session.codexHome,
    session,
    source: { agent: session.agent }
  }))
}

function session(index: number): AiVaultSession {
  return {
    id: String(index),
    executionHostId: 'local',
    agent: 'codex',
    sessionId: String(index),
    title: 'fixture',
    cwd: '/fixture',
    branch: null,
    model: null,
    filePath: `/fixture/rollout-${index}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

beforeEach(() => {
  fixture.sessions = []
})

const scan = (unlimited: boolean, limit?: number) => scanAiVaultSessions({ unlimited, limit })

it('capped scans still fill the unique-session budget', async () => {
  fixture.sessions = [
    session(0),
    ...Array.from({ length: 8 }, () => ({
      ...session(0),
      filePath: '/custom/rollout-0.jsonl',
      codexHome: '/custom'
    })),
    ...Array.from({ length: 10 }, (_, i) => session(i + 1))
  ]
  const result = await scan(false, 10)
  expect(result.sessions).toHaveLength(10)
  expect(new Set(result.sessions.map((row) => row.sessionId)).size).toBe(10)
})

it('retains only canonical rows during duplicate-heavy load-all scans', () => {
  const collection = new ScannedSessionCollection()
  for (let index = 0; index < 10000; index++) {
    const row = session(index % 100)
    collection.add({
      ...row,
      codexHome: '/custom',
      filePath: `/custom/rollout-${index % 100}.jsonl`
    })
    expect(collection.size).toBeLessThanOrEqual(100)
  }
  for (let index = 0; index < 100; index++) {
    collection.add(session(index))
  }
  expect(collection.size).toBe(100)
  expect([...collection.values()].every((row) => row.codexHome === null)).toBe(true)
})

it('admits rows sharing one session id across rollout names without rescanning', () => {
  const count = 4000
  let pathReads = 0
  const collection = new ScannedSessionCollection()
  for (let index = 0; index < count; index++) {
    const row = { ...session(index), sessionId: 'shared' }
    collection.add({
      ...row,
      get filePath() {
        pathReads++
        return row.filePath
      }
    })
  }
  expect(collection.size).toBe(count)
  expect(pathReads).toBeLessThanOrEqual(count * 4)
})
