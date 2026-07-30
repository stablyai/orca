import { describe, expect, it } from 'vitest'
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
        toolName: event.toolName
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
})
