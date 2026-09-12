import { beforeEach, expect, it, vi } from 'vitest'
import type * as CodexDedup from './codex-session-root-dedup'
import type { AiVaultSession } from '../../shared/ai-vault-types'

const fixture = vi.hoisted(() => ({ sessions: [] as AiVaultSession[], visits: 0 }))
vi.mock('./session-scanner-source-discovery', () => ({
  discoverAiVaultSessionSources: async () => [],
  DEFAULT_CODEX_HOME_DIR: '/fixture'
}))
vi.mock('./session-scanner-candidates', () => ({
  sessionCandidatesFromDiscoveries: async () => candidates()
}))
vi.mock('./session-parse-cache-persistence', () => ({
  ensureSessionParseCacheLoaded: async () => {},
  scheduleSessionParseCachePersist: () => {}
}))
vi.mock('./session-scanner-parse-cache', () => ({
  createSessionParseStats: () => ({
    reused: 0,
    incremental: 0,
    fullParses: 0,
    earlyStopped: 0,
    bytesRead: 0
  }),
  parseAgentSessionFileCached: async (candidate: { session: AiVaultSession }) => candidate.session
}))
vi.mock('./remote-session-scanner-sources', () => ({ remoteSessionSources: () => [{}] }))
vi.mock('./remote-session-scanner-discovery', () => ({
  discoverRemoteSourceCandidates: async () => candidates()
}))
vi.mock('./remote-session-parse-cache', () => ({
  remoteSessionParseHostKey: () => 'fixture',
  parseRemoteSessionFileCached: async ({ candidate }: { candidate: { session: AiVaultSession } }) =>
    candidate.session
}))
vi.mock('./codex-session-root-dedup', async (original) => {
  const actual = await original<typeof CodexDedup>()
  return {
    ...actual,
    dedupeCodexSessionsBySessionId: (sessions: AiVaultSession[]) => {
      fixture.visits += sessions.length
      return actual.dedupeCodexSessionsBySessionId(sessions)
    }
  }
})

import { scanAiVaultSessions } from './session-scanner'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { dedupeCodexSessionsBySessionId } from './codex-session-root-dedup'
import { CodexSessionAccumulator } from './codex-session-accumulator'

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
  fixture.visits = 0
})

for (const host of ['local', 'remote'] as const) {
  const scan = (unlimited: boolean, limit?: number) =>
    host === 'local'
      ? scanAiVaultSessions({ unlimited, limit })
      : scanRemoteAiVaultSessions({
          unlimited,
          limit,
          provider: { readDir: vi.fn(), readFile: vi.fn(), stat: vi.fn() },
          executionHostId: 'local',
          remoteHome: '/fixture',
          hostPlatform: {
            relayPlatform: 'linux-x64',
            os: 'linux',
            arch: 'x64',
            pathFlavor: 'posix',
            commandDialect: 'posix',
            pathSeparator: '/',
            pathDelimiter: ':'
          }
        })

  it(`${host}: load-all processes deduplication linearly and retains late canonical aliases`, async () => {
    fixture.sessions = Array.from({ length: 10000 }, (_, i) => session(i))
    fixture.sessions[0] = {
      ...fixture.sessions[0]!,
      codexHome: '/custom',
      filePath: '/custom/rollout-0.jsonl'
    }
    fixture.sessions.push(session(0))
    const expected = dedupeCodexSessionsBySessionId(fixture.sessions)
    fixture.visits = 0
    const started = performance.now()
    const result = await scan(true)
    process.stdout.write(
      `${JSON.stringify({ host, candidates: fixture.sessions.length, scanMs: performance.now() - started, dedupVisits: fixture.visits })}\n`
    )
    expect(result.issues).toEqual([])
    expect(result.sessions).toEqual(expected)
    expect(fixture.visits).toBeLessThanOrEqual(fixture.sessions.length * 2)
  }, 30000)

  it(`${host}: capped scans still fill the unique-session budget`, async () => {
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
}

it('incremental canonical selection preserves winner occurrence order, ties and repeated references', () => {
  const accumulator = new CodexSessionAccumulator()
  const same = session(0)
  const rows: AiVaultSession[] = []
  const variants: AiVaultSession[] = [
    same,
    same,
    { ...same, codexHome: '/custom', filePath: '/custom/rollout-0.jsonl' },
    { ...same, agent: 'claude' as const },
    { ...same, executionHostId: 'ssh:fixture' },
    { ...same, modifiedAt: '2026-02-01T00:00:00.000Z' },
    { ...same, filePath: '/aaa/rollout-0.jsonl' },
    session(1)
  ]
  let seed = 42
  for (let index = 0; index < 500; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const row = variants[seed % variants.length]!
    rows.push(row)
    accumulator.add(row)
    expect(accumulator.sessions()).toEqual(dedupeCodexSessionsBySessionId(rows))
  }
})

it('retains only canonical rows during duplicate-heavy load-all scans', () => {
  const accumulator = new CodexSessionAccumulator()
  for (let index = 0; index < 10000; index++) {
    const row = session(index % 100)
    accumulator.add({
      ...row,
      codexHome: '/custom',
      filePath: `/custom/rollout-${index % 100}.jsonl`
    })
    expect(accumulator.size).toBeLessThanOrEqual(100)
  }
  for (let index = 0; index < 100; index++) {
    accumulator.add(session(index))
  }
  expect(accumulator.size).toBe(100)
  expect(accumulator.sessions().every((row) => row.codexHome === null)).toBe(true)
})
