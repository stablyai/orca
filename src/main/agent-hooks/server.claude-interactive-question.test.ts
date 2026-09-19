import { describe, expect, it } from 'vitest'
import { seedLegacyAgentStatusForTests } from '../../shared/agent-hook-listener/listener-state'
import {
  CLAUDE_SUBAGENT_STALE_AFTER_MS,
  claudeRosterToSnapshots,
  upsertWorkingClaudeSubagent
} from '../../shared/claude-subagent-roster'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-question', '11111111-1111-4111-8111-111111111111')

function ingestClaudeStatus(
  server: AgentHookServer,
  event: {
    state: 'working' | 'waiting'
    hookEventName: 'PermissionRequest' | 'PreToolUse'
    toolName: string
    toolUseId: string
    interactivePrompt?: string
    subagents?: {
      id: string
      state: 'working' | 'idle'
      startedAt: number
      agentType?: string
    }[]
  }
): void {
  server.ingestRemote(
    {
      paneKey: PANE_KEY,
      tabId: 'tab-question',
      worktreeId: 'worktree-question',
      hookEventName: event.hookEventName,
      toolUseId: event.toolUseId,
      payload: {
        state: event.state,
        agentType: 'claude',
        toolName: event.toolName,
        ...(event.interactivePrompt ? { interactivePrompt: event.interactivePrompt } : {}),
        ...(event.subagents ? { subagents: event.subagents } : {})
      }
    },
    'connection-1'
  )
}

describe('Claude interactive-question status transitions', () => {
  it('clears an AskUserQuestion wait when later tool work starts', () => {
    const server = new AgentHookServer()

    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      toolUseId: 'tool-after-answer'
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        state: 'working',
        agentType: 'claude',
        toolName: 'Read'
      })
    ])
  })

  it('clears a PermissionRequest-shaped AskUserQuestion wait when later tool work starts', () => {
    // Why: newer Claude reports the AskUserQuestion wait as PermissionRequest;
    // the question must not inherit real-permission stickiness from that shape.
    const server = new AgentHookServer()

    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      toolUseId: 'tool-after-answer'
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        state: 'working',
        agentType: 'claude',
        toolName: 'Read'
      })
    ])
  })

  it('keeps an actual permission request sticky during unrelated tool work', () => {
    const server = new AgentHookServer()

    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'Bash',
      toolUseId: 'tool-needs-permission'
    })
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      toolUseId: 'tool-unrelated'
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        state: 'waiting',
        agentType: 'claude',
        toolName: 'Bash'
      })
    ])
  })
})

function answeredRequestFromSnapshot(
  server: AgentHookServer
): Parameters<AgentHookServer['inferQuestionAnswered']>[0] {
  const [entry] = server.getStatusSnapshot()
  return {
    paneKey: entry.paneKey,
    baselineUpdatedAt: entry.receivedAt,
    baselineStateStartedAt: entry.stateStartedAt,
    // Why: mirror the renderer, which echoes the entry's prompt verbatim —
    // these ingests carry none, and the server must strict-match that.
    baselinePrompt: entry.prompt as string,
    baselineAgentType: entry.agentType
  }
}

function escapeRequestFromSnapshot(
  server: AgentHookServer
): Parameters<AgentHookServer['inferInterrupt']>[0] {
  return {
    ...answeredRequestFromSnapshot(server),
    intent: 'plain-escape'
  }
}

describe('inferInterrupt for Claude interactive questions', () => {
  it.each(['PreToolUse', 'PermissionRequest'] as const)(
    'clears a %s AskUserQuestion wait after Escape',
    (hookEventName) => {
      const server = new AgentHookServer()
      ingestClaudeStatus(server, {
        state: 'waiting',
        hookEventName,
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-question',
        interactivePrompt: '{"questions":[{"question":"Pick one"}]}'
      })

      expect(server.inferInterrupt(escapeRequestFromSnapshot(server))).toBe(true)
      const [entry] = server.getStatusSnapshot()
      expect(entry).toMatchObject({ paneKey: PANE_KEY, state: 'working', agentType: 'claude' })
      expect(entry.toolName).toBeUndefined()
      expect(entry.interactivePrompt).toBeUndefined()
      expect(entry.interrupted).toBeUndefined()
    }
  )

  it('rejects Escape when the question baseline is stale', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })
    const request = { ...escapeRequestFromSnapshot(server), baselineUpdatedAt: 1 }

    expect(server.inferInterrupt(request)).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName: 'AskUserQuestion' })
    ])
  })

  it.each([
    ['plain-escape', 'Bash'],
    ['ctrl-c', 'AskUserQuestion']
  ] as const)('does not clear a Claude wait from %s on %s', (intent, toolName) => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName,
      toolUseId: 'tool-wait'
    })

    expect(server.inferInterrupt({ ...escapeRequestFromSnapshot(server), intent })).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName })
    ])
  })
})

describe('inferQuestionAnswered', () => {
  it('clears an AskUserQuestion wait when the submit keystroke is reported', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })

    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(true)
    // Why: the answered question must also drop the tool identity so the
    // question card cannot linger on the working row.
    const [entry] = server.getStatusSnapshot()
    expect(entry).toMatchObject({ paneKey: PANE_KEY, state: 'working', agentType: 'claude' })
    expect(entry.toolName).toBeUndefined()
    expect(entry.interactivePrompt).toBeUndefined()
  })

  it('clears a PermissionRequest-shaped AskUserQuestion wait (newer Claude)', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })

    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(true)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, state: 'working', agentType: 'claude' })
    ])
  })

  it('refuses when the cached status changed since the baseline was captured', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })
    const staleRequest = {
      ...answeredRequestFromSnapshot(server),
      baselineUpdatedAt: 1
    }

    expect(server.inferQuestionAnswered(staleRequest)).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName: 'AskUserQuestion' })
    ])
  })

  it('never clears a real permission request', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'Bash',
      toolUseId: 'tool-needs-permission'
    })

    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName: 'Bash' })
    ])
  })

  it('ignores panes that are not waiting on a question', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      toolUseId: 'tool-working'
    })

    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'working', toolName: 'Read' })
    ])
  })

  it('does not emit a working child snapshot after roster expiry flips the pane to done', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })

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
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question',
      subagents
    })

    expect(server._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(true)
    const [entry] = server.getStatusSnapshot()
    expect(entry).toMatchObject({ paneKey: PANE_KEY, state: 'working', agentType: 'claude' })
    expect(entry.subagents).toEqual([expect.objectContaining({ id: 'a1', state: 'working' })])
  })

  it('omits relayed child snapshots when the local roster is present but empty', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question',
      subagents: [{ id: 'a1', state: 'working', startedAt: Date.now(), agentType: 'Explore' }]
    })
    server._getStateForTests().claudeSubagentRosterByPaneKey.set(PANE_KEY, new Map())

    expect(server.inferQuestionAnswered(answeredRequestFromSnapshot(server))).toBe(true)
    expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
  })
})
