import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
// Hook bodies here are hand-built to the captured shape; server-claude-permission-captures.test.ts
// replays real 2.1.284 captures.
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

  // A teammate's own prompt or turn end reaches the main agent's pane as a hook carrying its agent_id.
  it('keeps the main agent permission through a child prompt and a child Stop', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const teammate = { agent_id: 'areviewer-0123abcd', agent_type: 'reviewer' }
      await postClaudeHook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'set perms' })
      await postClaudeHook(server, { hook_event_name: 'SubagentStart', ...teammate })
      await postClaudeHook(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-main'
      })
      await postClaudeHook(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' }
      })
      await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        ...teammate,
        prompt: 'review alpha.txt'
      })
      await postClaudeHook(server, { hook_event_name: 'Stop', ...teammate, background_tasks: [] })

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        toolName: 'Bash',
        mainAgent: { state: 'waiting' }
      })
      expect(server._getStateForTests().claudeLeadStateByPaneKey.get(PANE)?.approvals).toEqual([
        expect.objectContaining({ toolName: 'Bash', toolUseId: 'toolu-main' })
      ])

      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'chmod 644 alpha.txt' },
        tool_use_id: 'toolu-main'
      })
      expect(server.getStatusSnapshot()[0]?.state).toBe('working')
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

  describe('a prompt spooled while Orca was down', () => {
    const ALPHA_CALL = { tool_name: 'Bash', tool_input: { command: 'chmod 644 alpha.txt' } }
    const PERMISSION = { hook_event_name: 'PermissionRequest', ...ALPHA_CALL }
    let userDataPath: string
    let live: AgentHookServer
    let restarted: AgentHookServer | undefined

    beforeEach(async () => {
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-claude-spooled-prompt-'))
      live = new AgentHookServer()
      await live.start({ env: 'production', userDataPath })
      await postClaudeHook(live, { hook_event_name: 'UserPromptSubmit', prompt: 'set perms' })
      await postClaudeHook(live, {
        hook_event_name: 'PreToolUse',
        ...ALPHA_CALL,
        tool_use_id: 'toolu-alpha'
      })
    })

    afterEach(() => {
      live.stop()
      restarted?.stop()
      restarted = undefined
    })

    /** Quit a minute before relaunch, spool what the hooks could not POST meanwhile (whole seconds,
     *  as the shell writes it), relaunch. */
    async function relaunchWithSpooled(
      records: { payload: Record<string, unknown>; secondsAfterLastLive: number }[]
    ): Promise<AgentHookServer> {
      live.flushStatusPersistSync()
      const statusPath = live.lastStatusPath!
      live.stop()
      const persisted = JSON.parse(readFileSync(statusPath, 'utf8'))
      const row = persisted.entries[PANE]
      row.receivedAt -= 60_000
      row.stateStartedAt = Math.min(row.stateStartedAt, row.receivedAt)
      writeFileSync(statusPath, JSON.stringify(persisted))
      const lastLiveSecond = Math.floor(row.receivedAt / 1000) * 1000
      const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
      mkdirSync(spoolDir, { recursive: true })
      const lines = records.map(({ payload, secondsAfterLastLive }) =>
        JSON.stringify({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'production',
          source: 'claude',
          receivedAt: lastLiveSecond + secondsAfterLastLive * 1000,
          payload
        } satisfies SpoolRecord)
      )
      writeFileSync(join(spoolDir, 'pane-tab-1.jsonl'), `\n${lines.join('\n')}\n`)
      restarted = new AgentHookServer()
      await restarted.start({ env: 'production', userDataPath })
      return restarted
    }

    // No dialog can be answered while Orca's UI is down, so a prompt raised in that window is still
    // on screen at relaunch and must show its card; the answer can only arrive live, which settles it.
    it('shows the prompt after relaunch and releases it with the live completion', async () => {
      const server = await relaunchWithSpooled([{ payload: PERMISSION, secondsAfterLastLive: 2 }])
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        toolInput: 'chmod 644 alpha.txt'
      })

      await postClaudeHook(server, {
        hook_event_name: 'PostToolUse',
        ...ALPHA_CALL,
        tool_use_id: 'toolu-alpha'
      })

      expect(server.getStatusSnapshot()[0]?.state).toBe('working')
    })

    // Replaying the first prompt restamps the row; the second must still be judged by the last
    // live observation, not by that restamp.
    it('raises every prompt spooled while Orca was down', async () => {
      const server = await relaunchWithSpooled([
        { payload: PERMISSION, secondsAfterLastLive: 2 },
        {
          payload: { ...PERMISSION, tool_input: { command: 'chmod 644 beta.txt' } },
          secondsAfterLastLive: 3
        }
      ])

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        toolInput: 'chmod 644 beta.txt'
      })
    })

    // A prompt whose POST timed out while Orca was up is older than the pane's later live evidence;
    // its call was answered live and its completion is never spooled, so it must not raise.
    it('does not raise a spooled prompt older than the pane last live observation', async () => {
      await postClaudeHook(live, {
        hook_event_name: 'PostToolUse',
        ...ALPHA_CALL,
        tool_use_id: 'toolu-alpha'
      })
      const server = await relaunchWithSpooled([{ payload: PERMISSION, secondsAfterLastLive: -5 }])

      expect(server.getStatusSnapshot()[0]?.state).not.toBe('waiting')
    })

    it('releases a raised spooled prompt at a later spooled Stop', async () => {
      const server = await relaunchWithSpooled([
        { payload: PERMISSION, secondsAfterLastLive: 2 },
        { payload: { hook_event_name: 'Stop' }, secondsAfterLastLive: 3 }
      ])

      expect(server.getStatusSnapshot()[0]?.state).toBe('done')
    })
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
