import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'

afterEach(() => vi.useRealTimers())

it('keeps a week-old restored working turn unverifiable rather than dropping it', () => {
  const now = 1_800_000_000_000
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  const weekOld = now - 8 * 24 * 60 * 60 * 1000
  const row: AgentStatusIpcPayload = {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    connectionId: null,
    state: 'working',
    prompt: 'task',
    agentType: 'claude',
    receivedAt: weekOld,
    stateStartedAt: weekOld,
    restoredUnconfirmed: true,
    providerSession: { key: 'session_id', id: 'claude-session' }
  }
  expect(selectRuntimeHookAgentRowForPane([row]).restored).toEqual({
    payload: { state: 'working', prompt: 'task', agentType: 'claude' },
    updatedAt: weekOld,
    stateStartedAt: weekOld
  })
})
