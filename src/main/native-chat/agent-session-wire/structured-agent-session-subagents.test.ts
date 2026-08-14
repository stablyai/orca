import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { listStructuredSessionSubagents } from './structured-agent-session-subagents'
import { resolveSessionFilePath } from '../session-file-resolver'
import { listAiVaultSubagentSessionsInBackground } from '../../ai-vault/session-scanner-background'

vi.mock('../session-file-resolver', () => ({ resolveSessionFilePath: vi.fn() }))
vi.mock('../../ai-vault/session-scanner-background', () => ({
  listAiVaultSubagentSessionsInBackground: vi.fn()
}))

it.each(['codex', 'claude', 'openclaude'] as const)(
  'lists %s children under the pinned session account without starting a provider',
  async (agent) => {
    const record = agentSessionRecordFixture()
    record.agent = agent
    if (agent === 'codex') {
      record.provider = 'codex'
      record.providerHandleChain[0]!.handle = { provider: 'codex', threadId: 'parent-thread' }
      record.accountHome = { variable: 'CODEX_HOME', path: '/pinned-account' }
    }
    const path = join(record.accountHome.path, 'parent.jsonl')
    vi.mocked(resolveSessionFilePath).mockResolvedValue(path)
    const result = { sessions: [], issues: [] }
    vi.mocked(listAiVaultSubagentSessionsInBackground).mockResolvedValue(result)
    expect(await listStructuredSessionSubagents(record)).toBe(result)
    expect(resolveSessionFilePath).toHaveBeenLastCalledWith(
      agent,
      agent === 'codex' ? 'parent-thread' : 'provider-session-alpha-1',
      agent === 'codex'
        ? { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] }
        : { claudeProjectsDir: join(record.accountHome.path, 'projects') }
    )
    expect(listAiVaultSubagentSessionsInBackground).toHaveBeenLastCalledWith({
      agent: agent === 'codex' ? 'codex' : 'claude',
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
