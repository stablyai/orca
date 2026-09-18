import { describe, expect, it } from 'vitest'
import { seedLegacyAgentStatusForTests } from '../../../../../../shared/agent-hook-listener/legacy-agent-status-test-seed'
import {
  CLAUDE_SUBAGENT_STALE_AFTER_MS,
  claudeRosterToSnapshots,
  upsertWorkingClaudeSubagent
} from '../../../../../../shared/claude-subagent-roster'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { AgentHookServer } from '../../../agent-hook-server'

const PANE_KEY = makePaneKey('tab-question', '11111111-1111-4111-8111-111111111111')

function ingestClaudeQuestion(
  server: AgentHookServer,
  subagents?: {
    id: string
    state: 'working' | 'idle'
    startedAt: number
    agentType?: string
  }[]
): void {
  server.ingestRemote(
    {
      paneKey: PANE_KEY,
      tabId: 'tab-question',
      worktreeId: 'worktree-question',
      hookEventName: 'PreToolUse',
      toolUseId: 'tool-question',
      payload: {
        state: 'waiting',
        agentType: 'claude',
        toolName: 'AskUserQuestion',
        ...(subagents ? { subagents } : {})
      }
    },
    'connection-1'
  )
}

function answeredRequestFromSnapshot(server: AgentHookServer) {
  const [entry] = server.getStatusSnapshot()
  return {
    paneKey: entry.paneKey,
    baselineUpdatedAt: entry.receivedAt,
    baselineStateStartedAt: entry.stateStartedAt,
    baselinePrompt: entry.prompt as string,
    baselineAgentType: entry.agentType
  }
}

describe('Claude question roster expiry', () => {
  it('does not emit a working child snapshot after roster expiry flips the pane to done', () => {
    const server = new AgentHookServer()
    ingestClaudeQuestion(server)

    const state = server._getStateForTests()
    const roster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', { agentType: 'Explore' }, 1)
    state.claudeSubagentRosterByPaneKey.set(PANE_KEY, roster)
    state.claudeLeadStateByPaneKey.set(PANE_KEY, {
      state: 'waiting',
      stateBeforeWait: { state: 'done' }
    })
    const existing = state.lastStatusByPaneKey.get(PANE_KEY)
    if (!existing) {
      throw new Error('expected a waiting status row')
    }
    seedLegacyAgentStatusForTests(state, {
      ...existing,
      payload: {
        ...existing.payload,
        subagents: claudeRosterToSnapshots(roster)
      }
    })

    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(true)
    const [entry] = server.getStatusSnapshot()
    expect(entry).toMatchObject({ paneKey: PANE_KEY, state: 'done', agentType: 'claude' })
    expect(entry.subagents?.some((child) => child.state === 'working')).toBeFalsy()
    expect(Date.now() - 1).toBeGreaterThan(CLAUDE_SUBAGENT_STALE_AFTER_MS)
  })

  it('keeps relayed working child snapshots when main has no roster', () => {
    const server = new AgentHookServer()
    const subagents = [
      { id: 'a1', state: 'working' as const, startedAt: Date.now(), agentType: 'Explore' }
    ]
    ingestClaudeQuestion(server, subagents)

    expect(server._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(true)
    const [entry] = server.getStatusSnapshot()
    expect(entry).toMatchObject({ paneKey: PANE_KEY, state: 'working', agentType: 'claude' })
    expect(entry.subagents).toEqual([expect.objectContaining({ id: 'a1', state: 'working' })])
  })

  it('omits relayed child snapshots when the local roster is present but empty', () => {
    const server = new AgentHookServer()
    ingestClaudeQuestion(server, [
      { id: 'a1', state: 'working', startedAt: Date.now(), agentType: 'Explore' }
    ])
    server._getStateForTests().claudeSubagentRosterByPaneKey.set(PANE_KEY, new Map())

    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(true)
    expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
  })
})
