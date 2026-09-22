import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { SpoolRecord } from '../../shared/agent-hook-spool'
import { markClaudeLeadTurnInterrupted } from '../../shared/agent-hook-listener/providers/claude-roster-state'

/** Drives the durable spool path, which is how an event gets re-delivered in production. */
class ReplayableAgentHookServer extends AgentHookServer {
  replaySpooled(payload: Record<string, unknown>): void {
    this.ingestSpoolRecord({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      env: 'production',
      source: 'claude',
      hookEventName: String(payload.hook_event_name),
      receivedAt: Date.now(),
      payload
    } satisfies SpoolRecord)
  }
}

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
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

const postClaudeHook = async (
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<Response> => postHookEvent(server, buildBody(payload))

// STA-3049. A Claude permission prompt is held for exactly as long as it is outstanding: it is
// raised by the PermissionRequest and destroyed when the approved call's completion is observed,
// with the turn boundary as an unconditional sweep. Nothing latches on the row behind that.
describe('Claude pending-approval lifecycle', () => {
  // STA-3049 — the approved tool's own completion must release the wait. Captured live on Claude
  // Code 2.1.270: PermissionRequest carries no tool_use_id, and Claude announces a parallel batch's
  // siblings between a call's PreToolUse and its PermissionRequest, so the prompt cannot inherit an
  // id by adjacency. Before the fix every event after the prompt was discarded for the whole turn.
  it('resumes working when a tool approved from a parallel batch completes', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'set permissions'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-alpha'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 beta.txt' },
        tool_use_id: 'toolu-beta'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })

      expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')

      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-alpha'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'claude' })
      ])
    } finally {
      server.stop()
    }
  })

  // STA-3049 — the same release when the prompt's own PreToolUse POST lost the race and landed
  // after it, so the prompt never had an id to inherit even from the adjacent event.
  it('resumes working when a late-announced approved tool completes', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'set permissions'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-late'
      })

      expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')

      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-late'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/next.txt' },
        tool_use_id: 'toolu-next'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'claude' })
      ])
    } finally {
      server.stop()
    }
  })

  // STA-3049, the inverted direction — a prompt still on screen must survive a whole batch of
  // unrelated working traffic, including a sibling's completion and a subagent's tool activity.
  it('keeps a still-pending permission visible across a parallel batch and child activity', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'set permissions'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-alpha'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 beta.txt' },
        tool_use_id: 'toolu-beta'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })

      // A sibling of the same batch finishing, a child's tool traffic, and an unrelated lead call
      // are all `working` evidence that says nothing about the prompt still on screen.
      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 beta.txt' },
        tool_use_id: 'toolu-beta'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        agent_id: 'agent-child-a',
        agent_type: 'Review',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/child.txt' },
        tool_use_id: 'toolu-child'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'todo' },
        tool_use_id: 'toolu-grep'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'chmod 644 alpha.txt'
        })
      ])
    } finally {
      server.stop()
    }
  })

  // STA-3049 — every outstanding prompt needs a way to die: the turn boundary sweeps the set, so
  // an approval nobody ever answered for cannot be inherited by the next turn.
  it('releases an unanswered permission at the turn boundary', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })
      await postClaudeHook(server, { hook_event_name: 'Stop' })
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'next turn' })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/next-turn.txt' },
        tool_use_id: 'toolu-next-turn'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'claude' })
      ])
    } finally {
      server.stop()
    }
  })

  // STA-3049 — Orca's hook transport is at-least-once: the shell spools a POST it could not make
  // and the server re-ingests it later. The spool deliberately skips PreToolUse/PostToolUse, so it
  // can re-deliver a prompt while structurally never re-delivering the completion that settles it.
  // An honoured replay would therefore pin an amber row nothing could ever release.
  it('does not reopen an answered permission when the prompt is replayed from the spool', async () => {
    const server = new ReplayableAgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'set perms' })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-alpha'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })
      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-alpha'
      })
      expect(server.getStatusSnapshot()[0]?.state).toBe('working')

      server.replaySpooled({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })

      expect(server.getStatusSnapshot()[0]?.state).toBe('working')
    } finally {
      server.stop()
    }
  })

  // The same rule must not depend on the ledger still remembering the turn: a replay arriving
  // after the turn closed has no live process behind it either.
  it('does not reopen a permission replayed after the turn already ended', async () => {
    const server = new ReplayableAgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'set perms' })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })
      await postClaudeHook(server, { hook_event_name: 'Stop' })
      expect(server.getStatusSnapshot()[0]?.state).toBe('done')

      server.replaySpooled({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })

      expect(server.getStatusSnapshot()[0]?.state).toBe('done')
    } finally {
      server.stop()
    }
  })

  // STA-3049 — every turn-ending path funnels through one sweep. A path that kept its own copy of
  // the clear is how a row strands when that copy is missed, so each ending is pinned here.
  it.each([
    ['Stop', { hook_event_name: 'Stop' }],
    ['StopFailure', { hook_event_name: 'StopFailure' }],
    ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'a new turn' }],
    ['SessionStart', { hook_event_name: 'SessionStart', source: 'startup' }]
  ])('releases an unanswered permission at a %s boundary', async (_name, ending) => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })
      expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')

      await postClaudeHook(server, ending)
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/after-boundary.txt' },
        tool_use_id: 'toolu-after'
      })

      // Why the card too: a swept ledger that still re-stated the previous row would read
      // `working` while rendering the dead approval, which is the same stale card by another name.
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          toolName: 'Read',
          interactivePrompt: undefined
        })
      ])
    } finally {
      server.stop()
    }
  })

  // The interrupt path reaches the same sweep. Orca has a separate known bug where an interrupt
  // does not settle a `waiting` row; this pins that the ledger does not add a second reason for it.
  it('releases an unanswered permission through an inferred interrupt', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'set perms' })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })
      expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')

      const leadState = server._getStateForTests().claudeLeadStateByPaneKey
      markClaudeLeadTurnInterrupted(server._getStateForTests(), PANE)
      expect(leadState.get(PANE)?.approvals ?? []).toEqual([])

      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/after-interrupt.txt' },
        tool_use_id: 'toolu-after-interrupt'
      })

      expect(server.getStatusSnapshot()[0]?.state).toBe('working')
    } finally {
      server.stop()
    }
  })
})
