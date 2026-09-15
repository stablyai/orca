import { expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
it('accepts the first real tool event after an idle SessionStart revives a retired pane', () => {
  const server = new AgentHookServer()
  server.retirePaneAuthority(PANE)
  server.ingestRemote(
    {
      paneKey: PANE,
      source: 'codex',
      hookEventName: 'SessionStart',
      providerSession: { key: 'session_id', id: 'new-session' },
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    },
    'conn-1'
  )
  expect(server.getStatusSnapshot()).toEqual([])
  server.ingestRemote(
    {
      paneKey: PANE,
      source: 'codex',
      hookEventName: 'PostToolUse',
      payload: {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        toolName: 'Bash',
        toolInput: 'pwd'
      }
    },
    'conn-1'
  )
  expect(server.getStatusSnapshot()).toEqual([
    expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'codex' })
  ])
})
