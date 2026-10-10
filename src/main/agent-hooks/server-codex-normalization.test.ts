import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

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

describe('Codex hook normalization', () => {
  it('tracks nested subagents with their role, model, and lifecycle state', () => {
    const root = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Coordinate the review',
        model: 'gpt-5.4'
      }),
      'production'
    )
    expect(root?.payload.model).toBe('gpt-5.4')

    const started = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'SubagentStart',
        session_id: 'child-session',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini'
      }),
      'production'
    )
    expect(started?.providerSession).toBeUndefined()
    expect(started?.payload).toMatchObject({
      state: 'working',
      prompt: 'Coordinate the review',
      model: 'gpt-5.4',
      subagents: [
        {
          id: 'child-session',
          agentType: 'reviewer',
          model: 'gpt-5.4-mini',
          state: 'working'
        }
      ]
    })

    const waiting = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PermissionRequest',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git fetch' }
      }),
      'production'
    )
    expect(waiting?.payload.state).toBe('waiting')
    expect(waiting?.payload.subagents?.[0].state).toBe('waiting')

    const workingAgain = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git fetch' }
      }),
      'production'
    )
    expect(workingAgain?.payload.state).toBe('working')
    expect(workingAgain?.payload.subagents?.[0].state).toBe('working')

    const rootStop = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'Stop', model: 'gpt-5.4' }),
      'production'
    )
    expect(rootStop?.payload.state).toBe('done')
    expect(rootStop?.payload.subagents).toBeUndefined()

    const resumedChild = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'pnpm test' }
      }),
      'production'
    )
    expect(resumedChild?.payload.state).toBe('working')
    expect(resumedChild?.payload.subagents?.[0]).toMatchObject({
      id: 'child-session',
      state: 'working'
    })

    const stopped = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'child-session' }),
      'production'
    )
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.subagents).toBeUndefined()
  })

  it('Stop carries last_assistant_message into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'Summary of what I did.'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.lastAssistantMessage).toBe('Summary of what I did.')
  })

  it('PreToolUse surfaces tool name + input preview and stays in working state', () => {
    // Why: Codex's PreToolUse fires for every tool call (not an approval), so map it to `working` not `waiting`; approvals flow through PermissionRequest.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git status', workdir: '/tmp' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('exec_command')
    expect(result?.payload.toolInput).toBe('git status')
  })

  it('PermissionRequest maps to waiting and surfaces the pending tool input', () => {
    // Why: PermissionRequest must map to `waiting` (sidebar red dot); treating it like PreToolUse would leave the pane looking busy while blocked on the user.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'exec_command',
        tool_input: { cmd: 'rm -rf build', workdir: '/tmp' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.agentType).toBe('codex')
    expect(result?.payload.toolName).toBe('exec_command')
    expect(result?.payload.toolInput).toBe('rm -rf build')
  })

  it('UserPromptSubmit does not extract tool fields even when the payload carries them', () => {
    // Why: UserPromptSubmit is a turn boundary; tool extraction is gated to Pre/PostToolUse so stray tool_name can't leak into the preview.
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Hello',
        tool_name: 'Edit',
        tool_input: { file_path: '/ignored.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('SessionStart clears cached tool state from a prior session', () => {
    // Seed a Stop snapshot with an assistant message.
    _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'Stop',
        last_assistant_message: 'Previous run finished'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBeUndefined()
  })

  it('SessionStart clears the cached prompt from a prior session until a new prompt arrives', () => {
    _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'stale prompt'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('')
  })
})

describe('Droid hook normalization', () => {
  it('UserPromptSubmit maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'ship this fix' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('droid')
    expect(result?.payload.prompt).toBe('ship this fix')
  })

  it('Notification maps permission prompts to waiting and idle prompts to done', () => {
    const waiting = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid needs your permission to use Execute'
      }),
      'production'
    )
    expect(waiting?.payload.state).toBe('waiting')

    const done = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid is waiting for your input'
      }),
      'production'
    )
    expect(done?.payload.state).toBe('done')

    const ignored = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Task completed successfully'
      }),
      'production'
    )
    expect(ignored).toBeNull()
  })

  it('Notification preserves the cached user prompt instead of using status text as prompt', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'write tests' }),
      'production'
    )

    const done = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Droid is waiting for your input'
      }),
      'production'
    )

    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('write tests')
    expect(done?.hasExplicitPrompt).toBe(false)
  })

  it('Notification ignores confirmation status text rather than treating it as permission', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'Notification',
        message: 'Confirmed configuration loaded'
      }),
      'production'
    )

    expect(result).toBeNull()
  })

  it('SubagentStop does not mark Droid done for mission progress', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'SubagentStop',
        last_assistant_message: '# Completed Wrote the requested validation assertions'
      }),
      'production'
    )

    expect(result).toBeNull()
  })

  it('PreToolUse maps to working and surfaces the tool name and input preview', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/example.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('Read')
    expect(result?.payload.toolInput).toBe('/tmp/example.ts')
  })

  it('PreToolUse falls back to the `name` and `input` fields when tool_name/tool_input are absent', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        name: 'Bash',
        input: { command: 'pnpm typecheck' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('Bash')
    expect(result?.payload.toolInput).toBe('pnpm typecheck')
  })

  it('PreToolUse AskUser maps to waiting for human input', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUser',
        tool_input: { question: 'Which permission-requiring action should I perform?' }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('AskUser')
  })

  it('PreToolUse high-risk Execute maps to waiting for approval', () => {
    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Execute',
        tool_input: {
          command: 'echo "test modification" >> ~/.claude/config.json',
          riskLevel: 'high',
          riskLevelReason: "This command modifies the user's Claude Code config file."
        }
      }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.toolName).toBe('Execute')
    expect(result?.payload.toolInput).toBe('echo "test modification" >> ~/.claude/config.json')
  })

  it('PermissionRequest maps low-impact Edit approvals to waiting and carries cached tool', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'edit it to none' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/Users/thebr/.claude/settings.json',
          old_str: '"preferredNotifChannel": "terminal_bell"',
          new_str: '"preferredNotifChannel": "none"'
        }
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'PermissionRequest' }),
      'production'
    )

    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.prompt).toBe('edit it to none')
    expect(result?.payload.toolName).toBe('Edit')
    expect(result?.payload.toolInput).toBe('/Users/thebr/.claude/settings.json')
  })

  it('SessionStart resets turn caches without marking Droid working', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'old prompt' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/old.ts' }
      }),
      'production'
    )

    const sessionStart = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'SessionStart' }),
      'production'
    )
    expect(sessionStart).toBeNull()

    const nextTool = _internals.normalizeHookPayload(
      'droid',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Execute',
        tool_input: { command: 'pwd' }
      }),
      'production'
    )
    expect(nextTool?.payload.state).toBe('working')
    expect(nextTool?.payload.prompt).toBe('')
    expect(nextTool?.payload.toolName).toBe('Execute')
    expect(nextTool?.payload.toolInput).toBe('pwd')
  })

  it('Stop maps to done and preserves the cached prompt', () => {
    _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'write tests' }),
      'production'
    )
    const stop = _internals.normalizeHookPayload(
      'droid',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.prompt).toBe('write tests')
  })
})

describe('Gemini hook normalization', () => {
  it('BeforeTool surfaces toolName + toolInput', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
        tool_input: { path: '/src/index.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('read_file')
    expect(result?.payload.toolInput).toBe('/src/index.ts')
  })

  it('falls back to args when tool_input is absent', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'BeforeTool',
        tool_name: 'run_shell_command',
        args: { command: 'git status' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('run_shell_command')
    expect(result?.payload.toolInput).toBe('git status')
  })

  it('BeforeAgent clears the cached tool state from a prior turn', () => {
    _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
        tool_input: { path: '/stale.ts' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({ hook_event_name: 'BeforeAgent' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('AfterAgent carries prompt_response into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'AfterAgent',
        prompt: 'what did you do',
        prompt_response: 'I ran the tests and they passed.',
        stop_hook_active: false
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.lastAssistantMessage).toBe('I ran the tests and they passed.')
  })
})

describe.each(['opencode', 'opencode2'] as const)('%s hook normalization', (source) => {
  it('SessionBusy maps to working', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe(source)
  })

  it('SessionBusy does NOT clear the cached user prompt', () => {
    // Why: OpenCode caches the user's MessagePart before SessionBusy fires, so the cached prompt is this turn's; clearing it would clobber the dashboard.
    _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'new prompt' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('new prompt')
  })

  it('SessionIdle maps to done', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe(source)
  })

  it.each([
    ['UnknownError', 'failure', undefined],
    ['MessageAbortedError', 'cancellation', true]
  ])('retains the reported root outcome for %s', (errorName, outcome, interrupted) => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'SessionIdle',
        root_state: 'done',
        root_turn_error_name: errorName
      }),
      'production'
    )
    expect(result?.payload.mainAgent).toMatchObject({ state: 'done', outcome })
    expect(result?.payload.interrupted).toBe(interrupted)
  })

  it('does not infer an outcome for an older plugin', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(result?.payload.mainAgent).toBeUndefined()
  })

  it('keeps a root failure beside still-working child work', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'SessionBusy',
        root_state: 'done',
        root_turn_error_name: 'api'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.mainAgent).toMatchObject({ state: 'done', outcome: 'failure' })
  })

  it('PermissionRequest maps to waiting', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'PermissionRequest' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
  })

  it('AskUserQuestion maps to waiting', () => {
    // Why: AskUserQuestion leaves the agent idle-but-waiting on a human, so it must map to `waiting` (red dot) like permission.asked, not stay `working`.
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'AskUserQuestion' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.agentType).toBe(source)
  })

  it('unknown event name returns null', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SomeOtherEvent' }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('MessagePart with role=user surfaces text as the prompt and stays working', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'hi there',
        messageID: 'msg-1'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('hi there')
    expect(result?.hasExplicitPrompt).toBe(true)
    expect(result?.promptInteractionKey).toBe(`${source}-message-msg-1`)
  })

  it('MessagePart with role=assistant populates lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'assistant',
        text: 'Hello! How can I help?'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('Hello! How can I help?')
  })

  it('caps oversized MessagePart text from stale (pre-throttle) plugin builds', () => {
    // Why: stale plugin builds re-post the full reply on every part update, so the listener must cap the text to keep per-event work O(cap).
    const assistant = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'assistant',
        text: 'a'.repeat(500_000)
      }),
      'production'
    )
    expect(assistant?.payload.lastAssistantMessage?.length).toBe(8_000)

    // Why: prompt is capped at 200 by normalizeAgentStatusObject; assert oversized input still stays within that bound.
    const user = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'u'.repeat(500_000),
        messageID: 'msg-cap'
      }),
      'production'
    )
    expect(user?.payload.prompt?.length).toBe(200)
  })

  it('subsequent SessionIdle preserves cached prompt + assistant message', () => {
    _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'hi' }),
      'production'
    )
    _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'MessagePart', role: 'assistant', text: 'hello back' }),
      'production'
    )
    const done = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('hi')
    expect(done?.payload.lastAssistantMessage).toBe('hello back')
  })
})
