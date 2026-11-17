import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const envelope = {
  source: 'opencode',
  paneKey: PANE,
  worktreeId: 'workspace',
  connectionId: null,
  launchToken: 'generation',
  payload: { agentType: 'opencode', state: 'waiting', prompt: 'approval' }
} as const
const unavailable = { ...envelope, statusUnavailable: true, payload: null } as const

describe('optional tmux projection wire metadata', () => {
  let server: AgentHookServer
  beforeEach(() => {
    _internals.resetCachesForTests()
    server = new AgentHookServer()
  })
  afterEach(() => {
    server.stop()
  })

  it('clears a selected projection only for the matching host, workspace and generation', () => {
    server.ingestRemote(envelope, 'connection')
    server.ingestRemote(unavailable, 'old-connection')
    server.ingestRemote({ ...unavailable, launchToken: 'old-generation' }, 'connection')
    server.ingestRemote({ ...unavailable, worktreeId: 'foreign' }, 'connection')
    expect(server.getStatusSnapshot()).toHaveLength(1)
    server.ingestRemote(unavailable, 'connection')
    expect(server.getStatusSnapshot()).toHaveLength(0)
  })
})
