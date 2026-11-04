import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AiVaultListArgs,
  AiVaultListResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'
const mocks = vi.hoisted(() => ({
  local: vi.fn<() => Promise<AiVaultListResult>>(),
  ssh: vi.fn<(host: string, args?: AiVaultListArgs) => Promise<AiVaultListResult>>()
}))
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../ai-vault/cached-session-list', () => ({
  configureAiVaultSessionSources: vi.fn(),
  aiVaultSessionListCacheGeneration: () => 0,
  resetAiVaultSessionListCacheForTests: vi.fn(),
  invalidateAiVaultSessionListCache: vi.fn(),
  getAiVaultWslHomeDirs: vi.fn().mockResolvedValue([]),
  listAiVaultSessions: mocks.local
}))
vi.mock('../ai-vault/ssh-session-list', () => ({
  scanSshAiVaultSessions: mocks.ssh
}))
vi.mock('../ssh/ssh', () => ({
  getActiveSshAiVaultHostInfos: () =>
    ['one', 'two', 'three', 'four'].map((targetId) => ({ targetId }))
}))
const { _internals, registerAiVaultHandlers } = await import('./ai-vault')

function result(marker: string): AiVaultListResult {
  return {
    sessions: Array.from({ length: 4 }, (_, index) => ({
      id: `local:codex:${marker}-${index}`,
      executionHostId: 'local',
      agent: 'codex',
      sessionId: `${marker}-${index}`,
      title: marker,
      cwd: index === 0 ? '/other' : '/workspaces/project',
      branch: null,
      model: null,
      filePath: `/tmp/${marker}-${index}.jsonl`,
      codexHome: null,
      createdAt: null,
      updatedAt: null,
      modifiedAt: '2026-10-02T00:00:00Z',
      messageCount: 1,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: `codex resume ${marker}-${index}`,
      subagent: null
    })),
    issues: [],
    scannedAt: '2026-10-02T00:00:00Z'
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  mocks.local.mockResolvedValue({
    sessions: [],
    issues: [],
    scannedAt: '2026-10-02T00:00:00Z'
  })
  mocks.ssh.mockImplementation(async (host, input) => result(`${host}-${input?.scopePaths?.[0]}`))
})
afterEach(() => {
  _internals.resetAiVaultCacheForTests()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('retains the selected session through all-host merge and repeated cached reads', async () => {
  registerAiVaultHandlers({ getActiveRuntimeAiVaultHostInfos: () => [] })
  const full = result('selected')
  const selected = full.sessions[3]
  mocks.local.mockResolvedValue(full)
  const ordinary = { executionHostScope: 'all' as const, limit: 1 }
  expect((await _internals.listAiVaultSessions(ordinary)).sessions).toEqual([full.sessions[0]])
  for (let attempt = 0; attempt < 2; attempt++) {
    const value = await _internals.listAiVaultSessions({
      ...ordinary,
      selectedSessionId: selected.id
    })
    expect(value.sessions).toEqual([full.sessions[0], selected])
  }
  expect((await _internals.listAiVaultSessions(ordinary)).sessions).toEqual([full.sessions[0]])
})
