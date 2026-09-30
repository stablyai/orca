import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const ALPHA = { tool_name: 'Bash', tool_input: { command: 'chmod 644 alpha.txt' } }
const BETA = { tool_name: 'Bash', tool_input: { command: 'chmod 644 beta.txt' } }

// STA-3049. With the ledger deciding every hook, the row must still survive the evidence that
// names no tool call (an OSC repaint) and re-statements must not re-alert.
// Hook bodies here are hand-built; server-claude-permission-captures.test.ts replays real captures.
describe('a held Claude approval under repaint and re-statement', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  const post = (payload: Record<string, unknown>): Promise<Response> =>
    postHookEvent(server, buildBody(payload))

  function osc(state: 'working' | 'done', agentType: 'claude' | 'freebuff' = 'claude'): void {
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state, prompt: '', agentType }
    })
  }

  async function raiseAlphaBesideBeta(): Promise<void> {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'set permissions' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    await post({ hook_event_name: 'PreToolUse', ...BETA, tool_use_id: 'toolu-beta' })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
  }

  const row = () => server.getStatusSnapshot()[0]

  it('keeps the main agent prompt visible when OSC repaints working, even after a re-statement', async () => {
    await raiseAlphaBesideBeta()
    osc('working')
    expect(row()).toMatchObject({ state: 'waiting', toolName: 'Bash' })

    // A child event re-states the row under its own hook name; the freeze must not depend on it.
    await post({
      hook_event_name: 'PostToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/child.txt' },
      tool_use_id: 'toolu-child'
    })
    osc('working')
    expect(row()).toMatchObject({ state: 'waiting', toolInput: 'chmod 644 alpha.txt' })

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    expect(row()?.state).toBe('working')
  })

  // Deny emits no hook, so a denied prompt's record outlives its Claude; the next agent the user
  // runs in that pane must still be able to report itself.
  it('lets another agent working on the pane replace a lingering Claude prompt', async () => {
    await raiseAlphaBesideBeta()
    osc('working', 'freebuff')

    // The row keeps its fresh `claude` identity (resolveAgentStatusIdentity); only the wait ends.
    expect(row()?.state).toBe('working')
  })

  it('still lets OSC working clear an answered question, which emits no hook of its own', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'ask me' })
    await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Proceed?' }] },
      tool_use_id: 'toolu-question'
    })
    expect(row()?.state).toBe('waiting')

    osc('working')

    expect(row()?.state).toBe('working')
  })

  // The hole this PR closes: a child event re-stated the row, which disarmed the freeze, so a
  // sibling of the prompt's own batch finishing then dropped the card of a still-live dialog.
  it('keeps the prompt when a sibling completes after a child event re-stated the row', async () => {
    await raiseAlphaBesideBeta()
    await post({
      hook_event_name: 'PreToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/child.txt' },
      tool_use_id: 'toolu-child'
    })
    await post({ hook_event_name: 'PostToolUse', ...BETA, tool_use_id: 'toolu-beta' })

    expect(row()).toMatchObject({ state: 'waiting', toolInput: 'chmod 644 alpha.txt' })
  })

  // PermissionRequest carries no id, so a child's prompt must adopt the one its call announced, as
  // the main agent's does: an input-less completion of another call names only the tool.
  it('matches a child prompt by the id its call announced', async () => {
    const child = { agent_id: 'agent-child-a' }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
    await post({ hook_event_name: 'SubagentStart', ...child, agent_type: 'general-purpose' })
    await post({ hook_event_name: 'PreToolUse', ...child, ...ALPHA, tool_use_id: 'toolu-child' })
    await post({ hook_event_name: 'PermissionRequest', ...child, ...ALPHA })
    expect(row()?.state).toBe('waiting')

    await post({
      hook_event_name: 'PostToolUse',
      ...child,
      tool_name: 'Bash',
      tool_use_id: 'toolu-other'
    })
    expect(row()?.state).toBe('waiting')

    await post({ hook_event_name: 'PostToolUseFailure', ...child, tool_use_id: 'toolu-child' })
    expect(row()?.state).toBe('working')
  })

  it('releases a re-delivered prompt with the one completion of its call', async () => {
    await raiseAlphaBesideBeta()
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })

    expect(row()?.state).toBe('working')
  })

  // Two byte-identical calls in one batch give two id-less prompts no field can tell apart from a
  // re-delivery; the first call finishing must not drop the card of the second, still-live one.
  it('keeps the second prompt of two identical calls until both complete', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'twice' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-first' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-second' })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-first' })
    expect(row()?.state).toBe('waiting')

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-second' })
    expect(row()?.state).toBe('working')
  })

  // Clearing a child's prompt mid-turn must keep the announced ids that mark the second prompt real.
  it('still tells two identical prompts apart after a child prompt cleared mid-turn', async () => {
    const child = { agent_id: 'a1f00d', agent_type: 'general-purpose' }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'twice' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-first' })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-second' })
    await post({ hook_event_name: 'PermissionRequest', ...child, ...BETA })
    await post({ hook_event_name: 'SubagentStop', ...child })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-first' })
    expect(row()?.state).toBe('waiting')
  })

  // The renderer keys a wait's one needs-input alert on `waiting` + `stateStartedAt`, and a `working`
  // row in between resets that key (pinned renderer-side in
  // agent-completion-coordinator-attention-dispatch.test.ts). So one wait must reach readers as an
  // unbroken run of `waiting` rows sharing one `stateStartedAt`, however often it is re-stated.
  it('publishes every re-statement of one wait as the same unbroken wait', async () => {
    const pushed: { state: string; stateStartedAt?: number }[] = []
    server.subscribeEnrichedStatus((enriched) => {
      pushed.push({ state: enriched.payload.state, stateStartedAt: enriched.stateStartedAt })
    })
    await raiseAlphaBesideBeta()
    await post({
      hook_event_name: 'PostToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/child.txt' },
      tool_use_id: 'toolu-child'
    })
    await post({ hook_event_name: 'PostToolUse', ...BETA, tool_use_id: 'toolu-beta' })
    // A repaint that dropped the card here would make the next re-statement a fresh alert.
    osc('working')
    await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'todo' },
      tool_use_id: 'toolu-grep'
    })

    const firstWait = pushed.findIndex((payload) => payload.state === 'waiting')
    const during = pushed.slice(firstWait)
    expect(during.length).toBeGreaterThan(1)
    expect(during.every((payload) => payload.state === 'waiting')).toBe(true)
    expect(new Set(during.map((payload) => payload.stateStartedAt)).size).toBe(1)
  })

  // The card is the live prompt's. Answering the main agent's prompt while a child's is still on
  // screen must show the child's command, not the one that just ran.
  it('shows the prompt still outstanding once the other one is answered', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate and run' })
    await post({
      hook_event_name: 'PreToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Bash',
      tool_input: { command: 'child cmd' },
      tool_use_id: 'toolu-child'
    })
    await post({
      hook_event_name: 'PermissionRequest',
      agent_id: 'agent-child-a',
      tool_name: 'Bash',
      tool_input: { command: 'child cmd' }
    })
    await post({ hook_event_name: 'PreToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    await post({ hook_event_name: 'PermissionRequest', ...ALPHA })
    expect(row()).toMatchObject({ state: 'waiting', toolInput: 'chmod 644 alpha.txt' })

    await post({ hook_event_name: 'PostToolUse', ...ALPHA, tool_use_id: 'toolu-alpha' })
    expect(row()).toMatchObject({ state: 'waiting', toolName: 'Bash', toolInput: 'child cmd' })

    await post({
      hook_event_name: 'PostToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Bash',
      tool_input: { command: 'child cmd' },
      tool_use_id: 'toolu-child'
    })
    expect(row()?.state).toBe('working')
  })

  // A typed answer settles only the question on screen; a child's permission raised beside it is
  // still live, so the row stays a wait showing that prompt.
  it('keeps a child prompt live when the main agent question beside it is answered', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate and ask' })
    await post({
      hook_event_name: 'PermissionRequest',
      agent_id: 'agent-child-a',
      tool_name: 'Bash',
      tool_input: { command: 'child cmd' }
    })
    await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Proceed?' }] },
      tool_use_id: 'toolu-question'
    })
    const asked = row()
    expect(asked).toMatchObject({ state: 'waiting', toolName: 'AskUserQuestion' })

    expect(
      server.inferQuestionAnswered({
        paneKey: PANE,
        baselineUpdatedAt: asked?.receivedAt ?? 0,
        baselineStateStartedAt: asked?.stateStartedAt ?? 0,
        baselinePrompt: asked?.prompt ?? '',
        baselineAgentType: 'claude'
      })
    ).toBe(true)
    expect(row()).toMatchObject({
      state: 'waiting',
      toolName: 'Bash',
      toolInput: 'child cmd',
      stateStartedAt: asked?.stateStartedAt,
      mainAgent: { state: 'working' }
    })
    expect(row()?.interactivePrompt).toContain('child cmd')
    osc('working')
    expect(row()?.state).toBe('waiting')

    await post({
      hook_event_name: 'PostToolUse',
      agent_id: 'agent-child-a',
      tool_name: 'Bash',
      tool_input: { command: 'child cmd' }
    })
    expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
  })
})
