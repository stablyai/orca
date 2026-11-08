import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'
import { AGENT_STATUS_RUNS_RUNTIME_CAPABILITY } from '../../../../../shared/agent-status/contracts/agent-status-run-capability'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer ingestRemote', () => {
  it('never falls back to the legacy writer for a run-capable peer', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        advertisedAgentStatusCapabilities: [],
        payload: { state: 'working', prompt: 'unsupported peer', agentType: 'claude' }
      },
      'conn-1'
    )
    const olderPeerRow = server.getStatusSnapshot()[0]

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        advertisedAgentStatusCapabilities: [AGENT_STATUS_RUNS_RUNTIME_CAPABILITY],
        payload: { state: 'done', prompt: 'capable peer', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([olderPeerRow])
  })
})
