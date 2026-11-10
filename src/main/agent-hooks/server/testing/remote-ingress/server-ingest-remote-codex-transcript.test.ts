import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCachedPaneReplayEnvelope } from '../../../../../wsl-guest/agent-hook-cached-pane-status'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const CHILD = '01a16839-7f84-7ed3-aebf-ea51e50330cf'

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remote Codex unlabelled roster removals', () => {
  const childStart = (id: string, startedAt: number): AgentHookEventPayload => ({
    paneKey: PANE,
    connectionId: null,
    source: 'codex',
    providerSession: { key: 'session_id', id: 'root' },
    hookEventName: 'SubagentStart',
    toolAgentId: id,
    payload: {
      agentType: 'codex',
      prompt: 'Run the checks',
      state: 'working',
      mainAgent: { state: 'working', stateStartedAt: 1 },
      subagents: [{ id, state: 'working', startedAt }]
    }
  })
  const emptyPoll = (mainState: 'working' | 'done', toolAgentId?: string) => ({
    paneKey: PANE,
    source: 'codex',
    providerSession: { key: 'session_id', id: 'root' },
    toolAgentId,
    payload: {
      agentType: 'codex',
      prompt: 'Run the checks',
      state: mainState,
      mainAgent: { state: mainState, stateStartedAt: 1 }
    }
  })

  it('keeps children a restarted relay never listed', () => {
    const server = new AgentHookServer()
    server.beginRemoteRelaySession('wsl:Ubuntu')
    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.beginRemoteRelaySession('wsl:Ubuntu')
    const replay = buildCachedPaneReplayEnvelope({
      event: { ...childStart(CHILD, 1), hookEventName: 'SessionStart', toolAgentId: undefined },
      meta: { source: 'codex' }
    })
    server.ingestRemote(replay, 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: CHILD })]
    })
    server._getStateForTests().codexSubagentRosterByPaneKey.delete(PANE)
    server.ingestRemote(replay, 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents?.map((child) => child.id)).toEqual([
      CHILD
    ])

    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ state: 'done' })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents).toBeUndefined()
  })
})
