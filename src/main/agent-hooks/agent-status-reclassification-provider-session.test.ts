import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

afterEach(() => {
  vi.useRealTimers()
})

describe('agent status reclassification provider session', () => {
  it('drops the incoming provider session when the pane keeps another agent identity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        providerSession: { key: 'session_id', id: 'codex-session' },
        payload: { state: 'working', prompt: 'parent task', agentType: 'codex' }
      },
      'connection-1'
    )

    vi.setSystemTime(1_001)
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        providerSession: {
          key: 'session_id',
          id: 'claude-session',
          transcriptPath: '/home/user/.claude/projects/repo/claude-session.jsonl'
        },
        payload: { state: 'working', prompt: 'nested task', agentType: 'claude' }
      },
      'connection-1'
    )

    const status = server.getStatusSnapshot()[0]
    expect(status).toMatchObject({ paneKey: PANE_KEY, agentType: 'codex' })
    expect(status).not.toHaveProperty('providerSession')
  })
})
