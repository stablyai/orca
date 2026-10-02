import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import {
  listHostSubagentSessions,
  listStructuredSessionSubagents
} from './structured-agent-session-subagents'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { agentSessionProviderHandleRoot } from '../../../shared/agent-session-provider-handle'
import { resolveSessionFilePath } from '../session-file-resolver'
import { listAiVaultSubagentSessionsInBackground } from '../../ai-vault/session-scanner-background'

vi.mock('../session-file-resolver', () => ({ resolveSessionFilePath: vi.fn() }))
vi.mock('../../ai-vault/session-scanner-background', () => ({
  listAiVaultSubagentSessionsInBackground: vi.fn()
}))

function child(filePath: string): AiVaultSession {
  return {
    id: filePath,
    sessionId: filePath,
    filePath,
    agent: 'omp',
    executionHostId: 'local',
    title: 'Worker',
    cwd: null,
    branch: null,
    model: null,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: { parentSessionId: 'parent', agentType: null, status: null }
  }
}

it.each(['codex', 'claude', 'openclaude', 'grok', 'omp'] as const)(
  'lists %s children under the pinned session account without starting a provider',
  async (agent) => {
    const record = agentSessionRecordFixture()
    record.agent = agent
    if (agent === 'codex') {
      record.provider = 'codex'
      record.providerHandleChain[0]!.handle = { provider: 'codex', threadId: 'parent-thread' }
      record.accountHome = { variable: 'CODEX_HOME', path: '/pinned-account' }
    } else if (agent === 'grok' || agent === 'omp') {
      record.provider = 'acp'
      record.providerHandleChain[0]!.handle = { provider: 'acp', agent, sessionId: 'parent-thread' }
      record.accountHome = { variable: 'HOME', path: '/pinned-account' }
    }
    const path = join(record.accountHome.path, 'parent.jsonl')
    vi.mocked(resolveSessionFilePath).mockResolvedValue(path)
    const result = { sessions: [], issues: [] }
    vi.mocked(listAiVaultSubagentSessionsInBackground).mockResolvedValue(result)
    expect(await listStructuredSessionSubagents(record)).toBe(result)
    expect(resolveSessionFilePath).toHaveBeenLastCalledWith(
      agent,
      agent === 'claude' || agent === 'openclaude' ? 'provider-session-alpha-1' : 'parent-thread',
      {
        codex: { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] },
        claude: { claudeProjectsDir: join(record.accountHome.path, 'projects') },
        openclaude: { claudeProjectsDir: join(record.accountHome.path, 'projects') },
        grok: { grokSessionsDir: join(record.accountHome.path, '.grok', 'sessions') },
        omp: { ompSessionsDir: join(record.accountHome.path, '.omp', 'agent', 'sessions') }
      }[agent]
    )
    expect(listAiVaultSubagentSessionsInBackground).toHaveBeenLastCalledWith({
      agent: agent === 'openclaude' ? 'claude' : agent,
      parentFilePath: path
    })
  }
)

it('handles a not-yet-written transcript and rejects an unknown Orca session', async () => {
  vi.mocked(resolveSessionFilePath).mockResolvedValue(null)
  expect(await listStructuredSessionSubagents(agentSessionRecordFixture())).toEqual({
    sessions: [],
    issues: []
  })
  await expect(listStructuredSessionSubagents(null)).rejects.toThrow('agent_session_not_found')
})

it('prefers the live adapter transcript path for a configured provider home', async () => {
  const record = agentSessionRecordFixture()
  record.agent = 'omp'
  record.provider = 'acp'
  record.accountHome = { variable: 'HOME', path: '/pinned-home' }
  record.providerHandleChain[0]!.handle = { provider: 'acp', agent: 'omp', sessionId: 'parent' }
  await listStructuredSessionSubagents(record, '/custom/omp/parent.jsonl')
  expect(resolveSessionFilePath).toHaveBeenLastCalledWith('omp', 'parent', {
    ompSessionsDir: join('/pinned-home', '.omp', 'agent', 'sessions'),
    transcriptPath: '/custom/omp/parent.jsonl'
  })
})

it('restores a custom transcript root without launch environment and ignores a previous conversation path', async () => {
  const record = agentSessionRecordFixture()
  record.agent = 'omp'
  record.provider = 'acp'
  record.accountHome = { variable: 'HOME', path: '/pinned-home' }
  record.providerHandleChain[0]!.handle = { provider: 'acp', agent: 'omp', sessionId: 'parent' }
  record.providerTranscript = {
    path: '/custom/omp/parent.jsonl',
    handleRoot: agentSessionProviderHandleRoot(record.providerHandleChain[0]!.handle)
  }
  await listStructuredSessionSubagents(record)
  expect(resolveSessionFilePath).toHaveBeenLastCalledWith(
    'omp',
    'parent',
    expect.objectContaining({ transcriptPath: '/custom/omp/parent.jsonl' })
  )
  record.providerHandleChain[0]!.handle = { provider: 'acp', agent: 'omp', sessionId: 'forked' }
  await listStructuredSessionSubagents(record)
  expect(resolveSessionFilePath).toHaveBeenLastCalledWith('omp', 'forked', {
    ompSessionsDir: join('/pinned-home', '.omp', 'agent', 'sessions')
  })
})

it('authorizes nested transcript requests through provider lineage and rejects foreign paths', async () => {
  const record = agentSessionRecordFixture()
  record.agent = 'omp'
  vi.mocked(resolveSessionFilePath).mockResolvedValue('/owner/root.jsonl')
  const children = new Map([
    ['/owner/root.jsonl', [child('/owner/root/Worker.jsonl')]],
    ['/owner/root/Worker.jsonl', [child('/owner/root/Worker.Nested.jsonl')]],
    ['/owner/root/Worker.Nested.jsonl', []]
  ])
  vi.mocked(listAiVaultSubagentSessionsInBackground).mockImplementation(
    async ({ parentFilePath }) => ({ sessions: children.get(parentFilePath) ?? [], issues: [] })
  )
  const result = await listStructuredSessionSubagents(record, null, '/owner/root/Worker.jsonl')
  expect(result.sessions.map((session) => session.filePath)).toEqual([
    '/owner/root/Worker.Nested.jsonl'
  ])
  await expect(
    listStructuredSessionSubagents(record, null, '/foreign/other.jsonl')
  ).rejects.toThrow('agent_session_operation_invalid')
  expect(listAiVaultSubagentSessionsInBackground).not.toHaveBeenCalledWith(
    expect.objectContaining({ parentFilePath: '/foreign/other.jsonl' })
  )
  const sameRoot = await listStructuredSessionSubagents(record, null, '/owner/root.jsonl')
  expect(sameRoot.sessions).toEqual(children.get('/owner/root.jsonl'))
})

it('overlays active and settled provider evidence by exact file path, not requested name or child UUID', async () => {
  const record = agentSessionRecordFixture()
  record.agent = 'omp'
  vi.mocked(resolveSessionFilePath).mockResolvedValue('/owner/root.jsonl')
  vi.mocked(listAiVaultSubagentSessionsInBackground).mockResolvedValue({
    sessions: [child('/owner/root/Worker-2.jsonl'), child('/other/Worker-2.jsonl')],
    issues: []
  })
  const readSubagents = vi.fn(() => [
    {
      id: 'Worker-2',
      transcriptPath: '/owner/root/Worker-2.jsonl',
      state: 'working' as const,
      runStatus: 'running' as const,
      startedAt: 10
    }
  ])
  const result = await listHostSubagentSessions(
    { store: { getRecord: () => record }, adapter: { readSubagents } },
    new Map(),
    record.sessionId
  )
  expect(result.sessions.map((session) => session.subagent?.status)).toEqual(['running', null])
})
