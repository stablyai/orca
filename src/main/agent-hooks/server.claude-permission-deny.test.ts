import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-deny', '22222222-2222-4222-8222-222222222222')

function ingestClaudeStatus(
  server: AgentHookServer,
  event: {
    state: 'working' | 'waiting'
    hookEventName: 'PermissionRequest' | 'PreToolUse' | 'UserPromptSubmit'
    toolName?: string
    toolUseId?: string
    prompt?: string
  }
): void {
  server.ingestRemote(
    {
      paneKey: PANE_KEY,
      tabId: 'tab-deny',
      worktreeId: 'worktree-deny',
      hookEventName: event.hookEventName,
      ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
      payload: {
        state: event.state,
        agentType: 'claude',
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.prompt !== undefined ? { prompt: event.prompt } : {})
      }
    },
    'connection-1'
  )
}

function denyRequestFromSnapshot(
  server: AgentHookServer
): Parameters<AgentHookServer['inferClaudePermissionDenied']>[0] {
  const [entry] = server.getStatusSnapshot()
  return {
    paneKey: entry.paneKey,
    baselineUpdatedAt: entry.receivedAt,
    baselineStateStartedAt: entry.stateStartedAt,
    baselinePrompt: entry.prompt as string,
    baselineAgentType: entry.agentType
  }
}

describe('inferClaudePermissionDenied', () => {
  it('settles a denied permission wait as an interrupted turn', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'Write',
      toolUseId: 'tool-denied'
    })

    expect(server.inferClaudePermissionDenied(denyRequestFromSnapshot(server))).toBe(true)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        state: 'done',
        agentType: 'claude',
        interrupted: true
      })
    ])
  })

  it('lets a new user prompt revive the pane after the inferred deny', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'Write',
      toolUseId: 'tool-denied'
    })
    server.inferClaudePermissionDenied(denyRequestFromSnapshot(server))

    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'UserPromptSubmit',
      prompt: 'try a different approach'
    })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, state: 'working', agentType: 'claude' })
    ])
  })

  it('refuses AskUserQuestion waits — those clear via the question inference', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-question'
    })

    expect(server.inferClaudePermissionDenied(denyRequestFromSnapshot(server))).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName: 'AskUserQuestion' })
    ])
  })

  it('refuses when the cached status changed since the baseline was captured', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'Write',
      toolUseId: 'tool-denied'
    })
    const staleRequest = {
      ...denyRequestFromSnapshot(server),
      baselineUpdatedAt: 1
    }

    expect(server.inferClaudePermissionDenied(staleRequest)).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName: 'Write' })
    ])
  })

  it('ignores panes that are not waiting on a permission', () => {
    const server = new AgentHookServer()
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      toolUseId: 'tool-working'
    })

    expect(server.inferClaudePermissionDenied(denyRequestFromSnapshot(server))).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'working', toolName: 'Read' })
    ])
  })
})
