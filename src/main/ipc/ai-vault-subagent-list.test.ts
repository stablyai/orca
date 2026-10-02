import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAiVaultSubagentSessions } from './ai-vault-subagent-list'
import { getAiVaultWslHomeDirs } from '../ai-vault/cached-session-list'
import { listAiVaultSubagentSessionsInBackground } from '../ai-vault/session-scanner-background'

vi.mock('../ai-vault/cached-session-list', () => ({ getAiVaultWslHomeDirs: vi.fn() }))
vi.mock('../ai-vault/session-scanner-background', () => ({
  listAiVaultSubagentSessionsInBackground: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GROK_HOME', '')
  vi.mocked(getAiVaultWslHomeDirs).mockResolvedValue([])
  vi.mocked(listAiVaultSubagentSessionsInBackground).mockResolvedValue({ sessions: [], issues: [] })
})
afterEach(() => vi.unstubAllEnvs())

describe('Grok subagent IPC boundary', () => {
  it('dispatches default and configured local Grok roots', async () => {
    const parentFilePath = join(
      homedir(),
      '.grok',
      'sessions',
      'repo',
      'parent',
      'chat_history.jsonl'
    )
    await listAiVaultSubagentSessions({ agent: 'grok', parentFilePath })
    expect(listAiVaultSubagentSessionsInBackground).toHaveBeenCalledWith({
      agent: 'grok',
      parentFilePath
    })
    vi.stubEnv('GROK_HOME', join(homedir(), 'grok-account'))
    const customPath = join(
      homedir(),
      'grok-account',
      'sessions',
      'repo',
      'parent',
      'chat_history.jsonl'
    )
    await listAiVaultSubagentSessions({ agent: 'grok', parentFilePath: customPath })
    expect(listAiVaultSubagentSessionsInBackground).toHaveBeenLastCalledWith({
      agent: 'grok',
      parentFilePath: customPath
    })
  })
  it('rejects remote host and paths outside the configured provider root', async () => {
    await listAiVaultSubagentSessions({ agent: 'grok', parentFilePath: '/etc/secrets' })
    await listAiVaultSubagentSessions({
      agent: 'grok',
      parentFilePath: join(homedir(), '.grok', 'sessions', '..', '..', 'secret'),
      executionHostId: 'local'
    })
    await listAiVaultSubagentSessions({
      agent: 'grok',
      parentFilePath: join(homedir(), '.grok', 'sessions', 'repo', 'parent', 'chat_history.jsonl'),
      executionHostId: 'ssh:other'
    })
    expect(listAiVaultSubagentSessionsInBackground).not.toHaveBeenCalled()
  })
})
