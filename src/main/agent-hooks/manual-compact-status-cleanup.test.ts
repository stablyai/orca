import { describe, expect, it, vi } from 'vitest'

import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const PANE_KEY = makePaneKey('manual-compact', '11111111-1111-4111-8111-111111111111')

function compactEvent(hookEventName: string, state: 'working' | 'done') {
  return {
    source: 'claude' as const,
    paneKey: PANE_KEY,
    hasExplicitPrompt: hookEventName === 'UserPromptSubmit' ? true : undefined,
    hookEventName,
    providerPromptId:
      hookEventName === 'UserPromptSubmit'
        ? '22222222-2222-4222-8222-222222222222'
        : '33333333-3333-4333-8333-333333333333',
    compactTrigger: hookEventName === 'UserPromptSubmit' ? undefined : ('manual' as const),
    providerSession: { key: 'session_id' as const, id: 'session-a' },
    payload: { state, prompt: 'work before compact', agentType: 'claude' as const }
  }
}

describe('manual compact status cleanup', () => {
  it('retires authority with pane, tab, and server cleanup', () => {
    const server = new AgentHookServer()
    const begin = (): void => {
      server.ingestRemote(compactEvent('UserPromptSubmit', 'working'), 'conn-a')
      server.ingestRemote(compactEvent('PreCompact', 'working'), 'conn-a')
    }

    begin()
    server.clearPaneState(PANE_KEY)
    server.ingestRemote(compactEvent('PostCompact', 'done'), 'conn-a')
    expect(server.getStatusSnapshot()).toEqual([])

    begin()
    server.dropStatusEntriesByTabPrefix('manual-compact')
    server.ingestRemote(compactEvent('PostCompact', 'done'), 'conn-a')
    expect(server.getStatusSnapshot()).toEqual([])

    server.stop()
    expect(server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
  })
})
